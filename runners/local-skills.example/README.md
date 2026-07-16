# Local skill overrides

Create private owner-only skill overrides under `runners/local-skills/<skill-name>/`.
This directory is ignored by Git. An override with the same name as a public
`runners/skills` entry is copied last for owner sessions only. Reviewer and
arbiter sessions continue to receive the public skill.

Keep credentials out of skill files. Copy local overrides separately when
deploying to another checkout.
