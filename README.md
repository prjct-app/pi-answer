# pi-answer

[![pi-answer — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-answer/main/docs/cover.png)](https://pi.dev)

Structured, concise replies for PI Agent. Each turn ends with a typed result:
a change, an answer, a diagnosis, a request for input, or a blocker.

The extension renders the result in the terminal. Code stays in files, with file
references in the reply; explanations are included when requested.

## Install

```sh
pi install npm:@prjct.app/pi-answer
```

## How it works

The extension registers an `answer` tool and asks the agent to call it once to
finish a turn. A turn that ends without the tool gets one reminder. Invalid
reply shapes are checked and repaired before rendering.

Reply kinds are `change`, `answer`, `diagnosis`, `needs_input`, and
`blocked`. The result displays the fields relevant to that kind, including
file references, verification results, or the decision needed from you.

## License

[MIT](LICENSE)
