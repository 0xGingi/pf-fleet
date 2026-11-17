# Changelog

What changed in each pf-fleet release, in plain words. To update, run
`docker compose pull && docker compose up -d` on your dashboard. Your nodes update
their agents on their own, after they finish whatever they're working on.

## 0.1.4

**Dressed like Pirate Face.** The dashboard now matches pirateface.co: the pirate
logo, a blackletter "Fleet", Pirate Face's dark navy and copper colours and its fonts.
Navigation moved to a top bar, the numbers are bigger and easier to read, and the
overview puts recent jobs full width so no column gets cut off. It also works better
on a phone. Light mode follows your system setting.

**Quieter lease waits.** Sometimes Pirate Face refuses a finished model as "already
been submitted" but keeps holding the lane's lease for 10 minutes. The agent used to
ask again every minute, logging an event each time. Now it waits the 10 minutes out
in one go, and you get one event per wait.

**Heads-up when a lane is going in circles.** Pirate Face sometimes hands a lane the
same model it just refused as "already submitted". The node's event log now warns
you when that happens, so you know why a lane keeps getting nowhere.

**Edge builds stay on the dashboard.** If you run the `edge` dashboard image, it no
longer pushes its agent to your nodes on its own. Only real releases go out
automatically. The "Update agent" button still works if you want an edge agent on a
node.

## 0.1.3

The "my lanes say starting forever" fix.

**Older agents work with a newer dashboard again.** If your nodes ran an agent
from before 0.1.2, the 0.1.2 dashboard ignored their status updates over a field
they didn't know about yet. Lanes looked stuck on "starting" and the event log
stayed empty. The dashboard now accepts agents that are a version behind, and if
it ever can't read something, its log says exactly which field.

**Look-alike builds get replaced.** A build of the dashboard made straight from
the code could hand out an agent with the same version number as a real release,
and then nothing would ever update it. Agents now report a fingerprint of their
own binary, so the dashboard spots a different build with the same number and
swaps in the real one. Local builds are also labelled `-dev` now, so they never
pretend to be a release.

If your lanes were stuck: update the dashboard and give the nodes a minute. They
update to 0.1.3 on their own.

## 0.1.2

The "set it and forget it" release.

**Always on the latest pirateface.** The dashboard checks PyPI every 30 minutes.
When a new pirateface comes out, every lane switches to it after finishing its
current model. No more workers stuck on an old version until something breaks.
You'll see the version on each lane and under Settings → pirateface, which also has
a "Check now" button if you're impatient.

**Alerts.** Paste a Discord or Slack webhook (or anything that takes JSON) into
Settings → Alerts and you'll hear about it when:

- a node goes offline for 2+ minutes (and when it comes back)
- a lane keeps failing for 10+ minutes (and when it recovers)
- Pirate Face refuses a submission or a job errors out
- an agent hits a problem, like uv missing or a failed update

Hit "Send test" to make sure it's working. Each type can be switched off.

**An event log for every node.** The node page now shows what the agent has been
up to: when it started, when it lost the connection (and for how long), updates,
worker crashes with the reason, and lease waits. The overview has a "Recent
events" feed across all your nodes. No more SSH-ing in to read journals.

**Logs stick around.** Worker output and events are saved now, so updating or
restarting the dashboard doesn't wipe them. Old history gets cleaned up
automatically after 180 days (you can change that in Settings → History).

**Reinstalling doesn't cost you work anymore.** Running the install command again
on a node used to kill whatever it was verifying. Now the agent waits for its lanes
to finish and then swaps itself over.

**Fixes and polish**

- The "Copy" buttons work when you open the dashboard over plain `http://`.
  (Browsers block the normal clipboard API there, so we use a fallback.)
- The dashboard loads faster: each page loads on its own, and the charts only load
  when you open a page that has them.

## 0.1.1

The "why does my node keep blinking offline" release.

**Nodes stay connected.** Agents were quietly dropping their connection every
couple of minutes and reconnecting, which looked like nodes flickering offline.
Now they send a little "still here" ping, so the connection stays up. And if a
connection does drop, the agent reconnects right away instead of waiting longer
each time.

**No more lease errors after a restart.** If a worker gets stopped mid-model,
Pirate Face holds onto that model for up to 10 minutes, and pf can't hand it back
early. The agent used to keep hammering away and logging errors the whole time.
Now it just waits it out and shows "waiting for the previous worker's lease to
lapse" on the lane. It even remembers this across agent restarts.

**Safer self-updates.** Fixed a rare hiccup where an agent update could fail with
"Text file busy" if the timing was unlucky. It just retries now.

## 0.1.0

The first release.

- One dashboard (Docker, port 1337) to run Pirate Face `pf work` lanes across all
  your machines.
- One-line install for each machine. It sets up uv, the agent, and a service that
  starts on boot. Works on x86_64 and ARM Linux, including seedboxes.
- Turn lanes on and off, choose "stop after this job" or "stop now", restart
  workers, and cap model size per machine.
- Pirate Face's rules built in: max 3 lanes per account, and lane names have to be
  unique per account.
- Live view of what every lane is verifying, with speed and ETA, plus throughput
  charts, jobs per day, a full job history and live worker output.
- Your Pirate Face keys are stored encrypted, and only the right agents ever see
  them.
- Agents update themselves when the dashboard updates: verified, and only after
  their current jobs finish.
