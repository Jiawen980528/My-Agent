# Tencent deployment setup

Status: files prepared, not yet installed on the server or pushed to GitHub.
This workflow is manual (`Actions > Deploy Tencent > Run workflow` on main).
Review CI and the complete change before running it. It builds in GitHub, uploads
an image over SSH, and never downloads Python dependencies on the production server.

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

The helper preserves the current Compose project name and Codex mount, uses
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
do not grant this chat access. SSH authentication and the deployment helper must
be tested after installation. No production deploy has been run from these files.
The health check verifies startup only, not holdings, charts, trading behavior or
AI routes. Resolve the known UI/data issues before promoting another release.
