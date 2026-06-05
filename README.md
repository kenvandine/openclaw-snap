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
openclaw onboard        # first-run setup wizard
openclaw               # interactive CLI
```

The background gateway service is installed and enabled as a systemd user unit the first time any `openclaw` command is run:

```
systemctl --user status openclaw
systemctl --user stop openclaw
systemctl --user start openclaw
```

## Design notes

**npm install instead of build from source** — `snap/snapcraft.yaml` installs the pre-built openclaw package directly from the npm registry rather than cloning and building from source with pnpm. This avoids pulling in the full build toolchain (pnpm, gcc, make) and the Tlon/Urbit extension workarounds that were required to get a clean build.

**Self-managed systemd user service** — Rather than using snapd's `daemon-scope: user` (which requires `sudo snap set system experimental.user-daemons=true`), the snap registers `openclaw.daemon` as a plain app so snapd creates the `/snap/bin/openclaw.daemon` wrapper. A systemd unit file shipped in the snap is installed to `~/.config/systemd/user/` on first run of any `openclaw` command.

**Classic confinement** — OpenClaw needs broad filesystem access (workspace files, arbitrary tools, code execution) so classic confinement is used. Chromium runs with `--no-sandbox` via a wrapper script since classic confinement provides no AppArmor policy.
