---
name: bash
description: Bash scripting conventions. Use when writing or editing shell scripts
---
first, read /skill:coding

# Bash if statements:

avoid:
```
[[ a != b ]] || {
  something
}
```

prefer:
```
if [[ a == b ]]; then
  something
fi
```
or
```
[[ a == b ]] && something
```
