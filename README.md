# openclaw snap

Snap packaging for [OpenClaw](https://github.com/openclaw/openclaw), a local-first personal AI assistant.

## Building

```
snapcraft
```

Snapcraft will download the latest published openclaw release from the npm registry, bundle Node.js 22, bake a pinned Chromium revision for Playwright, and produce `openclaw_<version>_amd64.snap`.

## Installing

```
sudo snap install --classic openclaw_<version>_amd64.snap --dangerous
```

## Usage

```
openclaw               # interactive CLI; prompts for Lemonade on first run
openclaw onboard       # OpenClaw's built-in onboarding wizard
openclaw.lemonade      # pick a local Lemonade model (interactive TUI)
openclaw.inference-snap  # pick a Canonical inference snap (interactive TUI)
```

The background gateway service is installed and enabled as a systemd user unit the first time any `openclaw` command is run:

```
systemctl --user status openclaw-gateway
systemctl --user stop openclaw-gateway
systemctl --user start openclaw-gateway
```

If Lemonade Server is already running on the host at `http://127.0.0.1:13305`, the first interactive `openclaw` launch offers to configure it as the model provider and fetches the OpenClaw Lemonade recipe catalog from `kenvandine/recipes`' `openclaw_recipes` branch at runtime. You can rerun that flow at any time with:

```
openclaw.lemonade
```

### Local AI with Canonical inference snaps

`openclaw.inference-snap` detects installed [Canonical inference snaps](https://snapcraft.io/search?q=inference)
such as `gemma4`, `gemma3`, `deepseek-r1`, `nemotron-3-nano`, or `qwen-vl`, probes
their OpenAI-compatible API, and lets you choose one as OpenClaw's primary provider.
It writes `~/.openclaw/openclaw.json` and restarts the gateway so the change takes
effect immediately. Re-run it any time to switch models.

```
sudo snap install gemma4
openclaw.inference-snap
```

Because snap refreshes are managed by snapd, the snap also disables OpenClaw's startup update hints and in-app self-update path.

The launchers also ignore legacy `/var/snap/ailab/...` OpenClaw environment overrides so old AILab container settings do not break the snap's config, state, or gateway token paths.

## Design notes

**npm install instead of build from source** — `snap/snapcraft.yaml` installs the pre-built openclaw package directly from the npm registry rather than cloning and building from source with pnpm. This avoids pulling in the full build toolchain (pnpm, gcc, make) and the Tlon/Urbit extension workarounds that were required to get a clean build.

**Self-managed systemd user service** — Rather than using snapd's `daemon-scope: user` (which requires `sudo snap set system experimental.user-daemons=true`), the snap registers `openclaw.daemon` as a plain app so snapd creates the `/snap/bin/openclaw.daemon` wrapper. A systemd unit file shipped in the snap is installed to `~/.config/systemd/user/` on first run of any `openclaw` command.

**Classic confinement** — OpenClaw needs broad filesystem access (workspace files, arbitrary tools, code execution) so classic confinement is used. Chromium runs with `--no-sandbox` via a wrapper script since classic confinement provides no AppArmor policy.

## Links

- Upstream project: <https://github.com/openclaw/openclaw> (https://openclaw.ai)
- Snap packaging: <https://github.com/kenvandine/openclaw-snap>
- Report a snap issue: <https://github.com/kenvandine/openclaw-snap/issues>

## License

OpenClaw is licensed under **MIT**. This snap packaging lives in [kenvandine/openclaw-snap](https://github.com/kenvandine/openclaw-snap).
