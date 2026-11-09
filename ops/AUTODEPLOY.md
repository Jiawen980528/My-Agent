# Tencent deployment setup

Status: code-package update prepared; the server helper must be upgraded once before using this workflow.
This workflow is manual (`Actions > Deploy Tencent > Run workflow` on main).
Review CI and the complete change before running it. It builds the frontend on GitHub and uploads only backend code and compiled frontend assets over SSH. The server reuses its existing Python environment, packages the new code locally with networking disabled, and never downloads dependencies for ordinary code changes. Container packaging remains local; full runtime images are not transferred.

## One-time server installation

Review `ops/myagent-deploy`, then copy it to the server. As an administrator:

```bash
sudo install -o root -g root -m 755 ops/myagent-deploy /usr/local/sbin/myagent-deploy
printf '%s\n' 'myagent-deploy ALL=(root) NOPASSWD: /usr/local/sbin/myagent-deploy' | sudo tee /etc/sudoers.d/myagent-deploy
sudo chmod 440 /etc/sudoers.d/myagent-deploy
sudo visudo -cf /etc/sudoers.d/myagent-deploy
```

This authorizes deployments of trusted repository code, not unrestricted sudo.
Do not grant the account Docker group membership. Protect main and review workflow
changes: an image deployment can execute code with existing application credentials.

Dependency declarations are compared before deployment; changed dependencies require a separately prepared runtime upgrade and fail before stopping the existing service.

The helper preserves the current Compose project name and Codex mount, explicitly disables orphan removal, uses
`--no-deps`, does not remove orphan containers, and backs up data with the app
stopped. Data changes are not automatically reversed on image rollback.
Existing stock-panel and MyAgent integration must be reviewed after deployment.

## GitHub settings

Existing repository secrets: DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY.
Add DEPLOY_KNOWN_HOSTS: on the trusted server, obtain its public host-key line:

```bash
printf '129.211.213.208 '; cat /etc/ssh/ssh_host_ed25519_key.pub
```

Store the whole resulting line, not a SHA256 fingerprint. Never use unchecked
`ssh-keyscan` from the runner or disable host verification. Secrets cannot be read
back by this chat. Configure the GitHub `production` environment, and optionally
required reviewers. No provider API key belongs in this workflow.

## Limits and validation

The cloud chat additionally needs valid GitHub write authentication (including
workflow-file permission) to push changes or start the workflow. Actions secrets
do not grant this chat access. SSH authentication is verified. The new code-package helper still needs a first end-to-end deployment after installation.
The health check verifies startup only, not holdings, charts, trading behavior or
AI routes. Resolve the known UI/data issues before promoting another release.


## Shared AI service update

The upgraded helper now updates both the existing stock-panel and MyAgent services. Install the updated setup script once before using this workflow version. Both existing Compose projects, runtime dependencies and persistent mounts are checked before stopping services. See `docs/shared-ai.md` for routing, migration, secret handling and rollback behavior.
