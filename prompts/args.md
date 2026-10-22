---
description: Echo arguments verbatim, to verify template substitution
argument-hint: "[arg1] [arg2]"
---
Reply with exactly this line and nothing else:
$1=[$1] $2=[$2] $@=[$@] ${1:-DEF}=[${1:-DEF}] ${@:2}=[${@:2}]
