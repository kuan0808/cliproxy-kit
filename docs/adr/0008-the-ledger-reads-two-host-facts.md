# The ledger reads two facts from the proxy itself

Status: accepted design for 0.2.0; implementation pending.

A fallback rule ([Running another model](../architecture.md#running-another-model-when-one-is-used-up))
can be made useless by two things only CLIProxyAPI knows: the models its accounts serve, and its
setting `upstream.claude.model-level-cooling`. A plugin is handed its own settings and nothing
else, and no host call returns either, so quota-pilot cannot check them. The ledger runs in the
panel with the management key ([The page](../architecture.md#the-page)), so it reads both from the
proxy's management API, in one module, and adds what it finds to the rules quota-pilot parsed:
"this proxy does not serve the target", "needs model-level-cooling".

## Considered Options

- Tell it after the fact: quota-pilot marks a rule once a routed request fails as a model the
  proxy does not serve. No coupling to the panel's API, but the fault shows only when the model has
  already run out, which is what the check is for.
- Leave both to the README: where they were, unread, when the owner's own install lacked the rule.
- The band checks against `/v1/models`: it has the list, but the rules are the proxy owner's to
  fix, and the band has no way to read the cooling setting.
- Read the whole config once and keep two values: simpler to write, and it brings every key of
  the proxy into the page's memory for nothing. A review caught it; the path reads replace it.

## Consequences

This is the one place where a surface finds something out for itself, and it only annotates: no
routing follows from it. A third read of the same kind tells the ledger which quota-pilot version
the Plugin Store selects. Each setting is asked for by its own path, one value per request: the
proxy's config as a whole holds client keys and upstream API keys, and the page never asks for it.

The page depends on two management routes of the proxy beside quota-pilot's own
([Management routes and the page](../architecture.md#management-routes-and-the-page)): a config
value by its path, and the models of a credential. A read that fails says "could not check" and
never "fine"; a path that is not set answers 404, which means off. No secret of the proxy's config
crosses the wire for this. The models are asked for the accounts quota-pilot lists, which are
Claude's and Codex's: a target on any other provider is marked "not checked", never "not served".
If the plugin API ever hands these facts to a plugin, the module goes and quota-pilot reports the
stops with the others.
