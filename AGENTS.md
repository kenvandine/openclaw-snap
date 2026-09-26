# Agents

This snap is now maintained by [automated-ken](https://github.com/kenvandine/automated-ken), a self-hosted agentic snap-maintenance dashboard.

## Responsibilities

- **Version detection**: Automated-ken polls upstream for new releases and opens version-bump PRs
- **CI monitoring**: Monitors build workflows and asks Copilot cloud agent to fix failing builds (on follow-up PRs)
- **YARF testing**: Runs YARF tests to verify snap functionality
- **Channel promotion**: Handles promotion from edge -> candidate -> stable

## Notes for Maintainers

- Do not hand-edit the pinned version in `package.json`
- The removed workflow's job is now automated-ken's responsibility
- All build and publish operations are now handled through the canonical workflow
