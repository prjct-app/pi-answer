# pi-answer

[![pi-answer — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-answer/main/docs/cover.png)](https://pi.dev)

Optional structured replies for PI Agent. A typed result can describe
a change, an answer, a diagnosis, a request for input, or a blocker.

The extension renders the result in the terminal. Code stays in files, with file
references in the reply; explanations are included when requested.

## Install

```sh
pi install npm:@prjct.app/pi-answer
```

## How it works

The extension registers an `answer` tool for structured results. Normal prose
also finishes a turn, without a reminder or another model request. Invalid
tool arguments are validated without silently dropping evidence. JSON-looking
assistant prose remains unchanged. Only explicitly required mode may convert a
valid structured reply written as text into a tool call.

Set `PI_ANSWER_REQUIRED=1` before starting Pi to require the tool for every reply.
In that mode, a turn without the tool gets at most one reminder.

Reply kinds are `change`, `answer`, `diagnosis`, `needs_input`, and
`blocked`. The result displays the fields relevant to that kind, including
file references, verification results, or the decision needed from you.

## License

[MIT](LICENSE)
