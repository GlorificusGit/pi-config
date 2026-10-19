/**
 * Mid-Prompt Slash Autocomplete
 *
 * Lets pi users complete prompt templates and skills from anywhere in a chat
 * message, and expand prompt templates inline, not just at the start of the
 * line.
 *
 *   - Typing a mid-prompt token such as `hi /skill:ask` or `hi /review`
 *     opens the autocomplete dropdown (filtered by name/description).
 *   - Tab accepts the highlighted item, Enter accepts and submits.
 *   - Prompt-template tokens are expanded inline on submission: the frontmatter
 *     is stripped and missing arguments fall back to their defaults.
 *   - Skill tokens (`/skill:name`) are left literal. Pi only force-expands
 *     skills at the start of a message, so inline tokens rely on the model
 *     loading the skill from pi's <available_skills> advertisement. Use a
 *     leading `/skill:name` when you need a guaranteed force-load.
 *   - Leading slash commands (/new, /reload, /skill:name, /template args) and
 *     @, #, and file-path completions are delegated unchanged to pi's built-in
 *     provider.
 *
 * Usage:
 *   pi --extension ./extensions/mid-prompt.ts
 *
 * Known limitations:
 *   - Inline prompt-template arguments are not parsed. Text after the token is
 *     left untouched and the template is expanded with an empty argument list,
 *     so `${N:-default}` uses the default and a bare `$N` becomes an empty
 *     string.
 *   - Inline `/skill:name` tokens are not force-expanded (see above).
 *   - Expansion is textual and applies everywhere the token appears, including
 *     quotes and inline or fenced code spans. There is no escape syntax yet.
 *   - Skill suggestions come from `pi.getCommands()`, which includes skills even
 *     when the `enableSkillCommands` setting is disabled. Mid-prompt skill
 *     suggestions are therefore not gated by that setting.
 *   - Completion only opens when the cursor is at the end of a command name.
 *
 * Graceful degradation:
 *   Auto-opening the dropdown relies on pi's private editor autocomplete
 *   trigger (`tryTriggerAutocomplete` / `requestAutocomplete`) and on the
 *   provider wrapper API. If a future pi release renames those internals the
 *   visual auto-trigger may stop; Tab completion (the public editor behavior),
 *   template injection, and literal skill tokens keep working.
 */

import { readFileSync } from "node:fs";
import { CustomEditor, stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Command index (skills + prompt templates)
// ---------------------------------------------------------------------------

type CommandKind = "skill" | "prompt";

interface IndexedCommand {
	/** Canonical command name, e.g. `skill:ask` or `review`. */
	displayName: string;
	/** Name used for fuzzy matching: the bare name for skills. */
	matchName: string;
	description?: string;
	kind: CommandKind;
	/** Template file path (prompt templates only). */
	path?: string;
}

/**
 * Build the skill/prompt index from `pi.getCommands()`.
 *
 * Note: `getCommands()` exposes skills regardless of the `enableSkillCommands`
 * setting, so mid-prompt skill suggestions are not gated by that setting.
 */
function getIndexedCommands(pi: ExtensionAPI): IndexedCommand[] {
	try {
		return pi.getCommands().flatMap((command): IndexedCommand[] => {
			if (command.source === "skill") {
				const matchName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
				return [
					{
						displayName: command.name,
						matchName,
						description: command.description,
						kind: "skill",
					},
				];
			}
			if (command.source === "prompt") {
				return [
					{
						displayName: command.name,
						matchName: command.name,
						description: command.description,
						kind: "prompt",
						path: command.sourceInfo?.path,
					},
				];
			}
			return [];
		});
	} catch {
		// getCommands() is only bound once a session exists; stay silent otherwise.
		return [];
	}
}

// ---------------------------------------------------------------------------
// Mid-prompt token extraction
// ---------------------------------------------------------------------------

/** Characters a command name may contain (skill names, template file names). */
const NAME_CHARS = "A-Za-z0-9_.:-";
const NAME_CHAR_RE = new RegExp(`[${NAME_CHARS}]`, "u");

/**
 * Matches a `/command` token at the end of `textBeforeCursor` that starts at a
 * token boundary. Capture group 1 is the name after the slash (may be empty on
 * a bare `/`).
 */
const MID_TOKEN_RE = new RegExp(`(?:^|[\\s\\t([{<\`"'])\\/([${NAME_CHARS}]*)$`, "u");

interface MidPromptToken {
	token: string;
	query: string;
}

/**
 * Extract a mid-prompt slash token ending at the cursor. Returns `null` when
 * the cursor is not at the end of such a token, or when the token is the
 * leading command of the whole message (which pi's built-in provider owns).
 */
function extractMidPromptToken(line: string, cursorCol: number, cursorLine: number): MidPromptToken | null {
	const textBeforeCursor = line.slice(0, cursorCol);
	const match = textBeforeCursor.match(MID_TOKEN_RE);
	if (!match) {
		return null;
	}
	const query = match[1] ?? "";
	const token = `/${query}`;
	const tokenStart = textBeforeCursor.length - token.length;
	// A token at the very start of the first line is a normal leading slash
	// command; delegate to pi. A token at the start of a later line is still
	// mid-message and is ours.
	if (cursorLine === 0 && tokenStart === 0) {
		return null;
	}
	// Only complete at the end of a token. This also avoids treating a path
	// segment such as `/etc` in `/etc/passwd` as a command name.
	const nextChar = line[cursorCol] ?? "";
	if (nextChar === "/" || nextChar === "\\" || NAME_CHAR_RE.test(nextChar)) {
		return null;
	}
	return { token, query };
}

// ---------------------------------------------------------------------------
// Autocomplete provider
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 20;

function buildSuggestions(pi: ExtensionAPI, query: string): AutocompleteItem[] {
	const commands = getIndexedCommands(pi);
	if (commands.length === 0) {
		return [];
	}

	const prompts = commands.filter((command) => command.kind === "prompt");
	const skills = commands.filter((command) => command.kind === "skill");

	const promptMatches = fuzzyFilter(prompts, query, (command) => command.displayName);
	const bareSkillMatches = fuzzyFilter(skills, query, (command) => command.matchName);
	const bareSkillSet = new Set(bareSkillMatches);
	const fullSkillMatches = fuzzyFilter(
		skills.filter((command) => !bareSkillSet.has(command)),
		query,
		(command) => command.displayName,
	);

	return [...promptMatches, ...bareSkillMatches, ...fullSkillMatches].slice(0, MAX_SUGGESTIONS).map((command) => ({
		value: `/${command.displayName}`,
		label: command.displayName,
		...(command.description ? { description: command.description } : {}),
	}));
}

function createMidPromptProvider(current: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
	// Prefix of the suggestion set we produced most recently. Used so that
	// applyCompletion can tell our mid-prompt tokens apart from the built-in
	// provider's leading-slash and file-path prefixes.
	let ownPrefix: string | undefined;

	return {
		get triggerCharacters(): string[] | undefined {
			return current.triggerCharacters;
		},

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] ?? "";
			const extracted = extractMidPromptToken(currentLine, cursorCol, cursorLine);

			if (!extracted) {
				ownPrefix = undefined;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = options.signal.aborted ? [] : buildSuggestions(pi, extracted.query);
			if (items.length === 0) {
				ownPrefix = undefined;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			ownPrefix = extracted.token;
			return { items, prefix: extracted.token };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix !== ownPrefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const currentLine = lines[cursorLine] ?? "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const insertion = item.value.endsWith(" ") ? item.value : `${item.value} `;
			const newLines = [...lines];
			newLines[cursorLine] = before + insertion + after;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: before.length + insertion.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const currentLine = lines[cursorLine] ?? "";
			if (extractMidPromptToken(currentLine, cursorCol, cursorLine)) {
				return true;
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

// ---------------------------------------------------------------------------
// Editor: auto-open the dropdown for mid-prompt slash tokens
// ---------------------------------------------------------------------------

function isTextProducingKey(data: string): boolean {
	if (data === "\x7f" || data === "\b") {
		return true; // backspace
	}
	if (data.length !== 1) {
		return false;
	}
	const code = data.charCodeAt(0);
	return code >= 32 && code !== 127;
}

class MidPromptEditor extends CustomEditor {
	handleInput(data: string): void {
		super.handleInput(data);

		if (!isTextProducingKey(data)) {
			return;
		}

		const editor = this as unknown as {
			isShowingAutocomplete?: () => boolean;
			tryTriggerAutocomplete?: (explicitTab?: boolean) => void;
			requestAutocomplete?: (options: { force: boolean; explicitTab: boolean }) => void;
		};

		if (editor.isShowingAutocomplete?.()) {
			return;
		}

		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (!extractMidPromptToken(line, cursor.col, cursor.line)) {
			return;
		}

		// Private editor trigger: this is the one fragile hook. If pi renames it,
		// only the visual auto-open is lost.
		if (typeof editor.tryTriggerAutocomplete === "function") {
			editor.tryTriggerAutocomplete(false);
		} else if (typeof editor.requestAutocomplete === "function") {
			editor.requestAutocomplete({ force: false, explicitTab: false });
		}
	}
}

// ---------------------------------------------------------------------------
// Template expansion on submission
// ---------------------------------------------------------------------------

/**
 * Substitute positional/default placeholders, mirroring pi's substituteArgs.
 *
 * Inline expansion always passes an empty argument list: text following a
 * mid-prompt token is not parsed as arguments. `${N:-default}` therefore uses
 * the default and `$N` becomes an empty string.
 */
function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number.parseInt(defaultTarget, 10) - 1];
				return value ? value : defaultValue;
			}
			if (sliceStart) {
				let start = Number.parseInt(sliceStart, 10) - 1;
				if (start < 0) {
					start = 0;
				}
				if (sliceLength) {
					return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") {
				return allArgs;
			}
			return args[Number.parseInt(simple, 10) - 1] ?? "";
		},
	);
}

const templateCache = new Map<string, string | undefined>();

function loadTemplateBody(path: string): string | undefined {
	if (templateCache.has(path)) {
		return templateCache.get(path);
	}
	let body: string | undefined;
	try {
		body = stripFrontmatter(readFileSync(path, "utf8"));
	} catch {
		body = undefined;
	}
	templateCache.set(path, body);
	return body;
}

/**
 * Map every prompt-template name to its argument-substituted body. Mid-prompt
 * template tokens are expanded with no positional arguments (text after the
 * token is left untouched), so `${N:-default}` placeholders resolve to their
 * defaults.
 */
function loadTemplateBodies(pi: ExtensionAPI): Map<string, string> {
	const bodies = new Map<string, string>();
	for (const command of getIndexedCommands(pi)) {
		if (command.kind !== "prompt" || !command.path) {
			continue;
		}
		const body = loadTemplateBody(command.path);
		if (body !== undefined) {
			bodies.set(command.displayName, substituteArgs(body, []));
		}
	}
	return bodies;
}

/**
 * Matches a mid-prompt slash token. The capture includes everything up to
 * whitespace or closing punctuation, so a path such as `/etc/passwd` is one
 * token (and never matches a command named `etc`).
 */
const MID_TEMPLATE_TOKEN_RE = new RegExp(`(^|[\\s\\t([{<\`"'])\\/([^\\s)\\]}>"'\`,;!?]+)`, "gu");

/**
 * Expand mid-prompt `/template` tokens inline. The leading command of the
 * message is left for pi's built-in expansion, and skill tokens are left
 * literal for lazy loading.
 *
 * Expansion is textual and applies everywhere a token appears, including
 * quotes and inline or fenced code spans. There is no escape syntax yet.
 */
function expandMidPromptTemplates(text: string, bodies: Map<string, string>): string {
	if (bodies.size === 0 || !text.includes("/")) {
		return text;
	}
	return text.replace(MID_TEMPLATE_TOKEN_RE, (match, boundary: string, token: string, offset: number) => {
		// Leading command at the very start of the message: built-in handles it.
		if (offset === 0 && boundary === "") {
			return match;
		}
		let body = bodies.get(token);
		let trailing = "";
		if (body === undefined) {
			// Allow sentence punctuation directly after a command, e.g. `/review.`.
			const trimmed = token.replace(/[.:]+$/, "");
			if (trimmed !== token) {
				body = bodies.get(trimmed);
				if (body !== undefined) {
					trailing = token.slice(trimmed.length);
				}
			}
		}
		if (body === undefined) {
			return match;
		}
		return `${boundary}${body}${trailing}`;
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Also invalidate on start in case a plugin host skips session_shutdown.
		templateCache.clear();
		ctx.ui.addAutocompleteProvider((current) => createMidPromptProvider(current, pi));
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new MidPromptEditor(tui, theme, keybindings));
	});

	pi.on("input", (event) => {
		// Extension-injected messages are not user prose.
		if (event.source === "extension" || !event.text.includes("/")) {
			return { action: "continue" };
		}
		const bodies = loadTemplateBodies(pi);
		const expanded = expandMidPromptTemplates(event.text, bodies);
		if (expanded === event.text) {
			return { action: "continue" };
		}
		return { action: "transform", text: expanded };
	});

	pi.on("session_shutdown", () => {
		templateCache.clear();
	});
}
