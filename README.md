# The Office

A pixel art office where your AI coding agents (Claude Code sessions) are animated characters that walk around, sit at desks, and visually reflect what each agent is doing in real time.

That's what she said.

This project is a fork of [Pixel Agents](https://github.com/pablodelucca/pixel-agents) by Pablo de Lucca.

![Screenshot](webview-ui/public/screeny.png)

## Build & Run

Would I rather be feared or loved? Easy. Both. I want people to be afraid of how much they love this app.

```bash
npm install
npm run build
npm start
```

Then open `http://localhost:3333` in your browser. Bears. Beets. Battlestar Galactica. Localhost:3333.

To start a new agent that can be recognized and persisted in the Office, you can use the `cl` command that you can register in your `.bashrc`/`.zshrc`:

```bash
# Start Claude with a random session ID (visible to pixel-agents standalone)
cl() { claude --session-id "$(uuidgen | tr '[:upper:]' '[:lower:]')" "$@"; }
```

## Why

[Sometimes I'll start a coding session and I don't even know where it's going. I just hope I find it along the way.](https://www.youtube.com/watch?v=QT07vyf0HQM)

## Aknowledgements

- This project is a fork of [Pixel Agents](https://github.com/pablodelucca/pixel-agents) by Pablo de Lucca. I made it standalone and added to it.
- Uses [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) by Louis Arge for the conference room feature.

## License

This project is licensed under the [MIT License](LICENSE). I'm not superstitious, but I am a little stitious about open source.

## Todos

- [ ] Give every worker their own memory and tiny description of their expertise
- [x] Make it possible to "call into work" any employee that is currently away (reboot previous sessions)
- [ ] Ability to make the agents talk to eighother (conference room 5 minutes!)
- [ ] Give every worker a job descriptoin and regular performance reviews
- [ ] Let the workers use project management tools (like clickup)
  - [ ] If moving between stages, delegate between workers

![The Office](https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExODg5bHdwNzE5YzBwejlkcnd5cGt2cjA4OW9heG1waHFvcDBoaDdoaSZlcD12MV9naWZzX3NlYXJjaCZjdD1n/BY8ORoRpnJDXeBNwxg/giphy.gif)
