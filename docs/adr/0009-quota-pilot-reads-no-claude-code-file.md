# quota-pilot reads no file of Claude Code's

Status: accepted design for 0.3.0; implementation pending.

In 0.1.x the plugin reads the transcripts under Claude Code's folder on the proxy's machine to
give a session its title and to tell that a session ran on that machine
([Where quota went](../architecture.md#where-quota-went)), while the band reads the same transcript
and sends the title with each quota read ([quota-band](../architecture.md#quota-band)). From 0.3.0
only the band does: what the plugin knows of a session is what its requests and its band say. The
plugin then reads nothing that belongs to another program, works the same on the proxy's machine,
in a container and from another device, and about 210 lines with their own index and patterns go.

## Considered Options

- Keep both readers: a session without a band on the proxy's own machine keeps the title Claude
  Code gave it, at the price of two readers of one file that must agree.
- Drop the band's reader and keep the plugin's: titles would stop working from any other device and
  in a container, the cases the band's reader was added for.

## Consequences

A session with no band (the SDK, `claude -p`, an install without quota-band) is titled by the first
line of its first request, wherever it runs. A session's project comes from what its band reports,
so the band reports a worktree's main repository.
