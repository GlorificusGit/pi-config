---
name: coding
description: Coding discipline. Use when writing or changing code to keep it DRY and YAGNI.
---
When coding, follow the following principles:
- DRY (don't repeat yourself)
- YAGNI principles (you arent gonna need it)
- spaces instead of tabs
- short and sweet variable names
- verbosity is the enemy
- don't limit yourself to 80 chars width, use extra width to reduce lines
- look for 'wins' such that rewriting the code in a simpler way actually increases readibility and understanding
- after coding, ask yourself if you can rewrite your code more DRY/YAGNI, or more concisely.
- these days AI is finding vulnerabilities everywhere. 3rd party code is a liability. be careful using 3rd party libraries and packages. stick to highly reputable 3rd party code. consider if you are better off writing the code you need from scratch. when in doubt, ask.

Respect these boundaries:
- you don't need to name every variable a single char (unless it actually makes sense sometimes)
- don't sacrifice readibilty for brevity.
- you don't need to stuff statements into 1 line that doesn't reasonably fit.

Review Loop:
After coding, review your code in the context of this skill, and refactor it if needed.
Then review the code again, until all principles are reasonably satisfied.

After the review loop, check to see if changes you made invalidated any docs. If so, align the docs with the changes.
