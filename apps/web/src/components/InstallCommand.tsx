import { CopyField } from "./CopyField";

export function InstallCommand({ command }: { command: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-2">Run this on the machine, as the user that should run the workers:</p>
      <CopyField value={command} />
      <ul className="list-disc space-y-1 pl-5 text-xs text-text-3">
        <li>It installs uv (if missing), the agent, and a systemd service that starts on boot.</li>
        <li>The token in it is shown only now. Lost it? Rotate the token on the node's page.</li>
        <li>Running it again later upgrades the agent in place.</li>
      </ul>
    </div>
  );
}
