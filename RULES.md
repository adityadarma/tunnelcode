# RemoteCode Coding Rules

- Do not use `any`.
- Use TypeScript strict mode.
- Do not write files longer than 300 lines unless there is a strong reason.
- One file has one main responsibility.
- Every API must be validated with Zod.
- Every WebSocket event must have a type defined in `packages/protocol`.
- Do not refactor across modules without a clear task.
- Do not add a dependency when Node.js built-ins are enough.
- Write simple, readable code rather than overly generic code.
- Everything in the code must be in English: comments, variable names, function names, commit messages, logs, and error messages.
- Do not write comments that reference milestone or task numbers.
- Comments explain reasoning or behavior, not work planning.
- Migrations are additive only: never drop, rename, or retype an existing table or column without explicit approval.
- Never edit a migration that has already shipped. Add a new one instead.
- A new column is either nullable or has a default, so existing rows stay valid.
