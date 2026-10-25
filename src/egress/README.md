# egress

The sandbox's only route out.

- **Phase 2:** allowlisting proxy on an internal-only network, DNS through the proxy, per-project companion allowlists, a log of every allowed and blocked request, and a read-only tool that returns the current sandbox's blocked requests.
- **Phase 3:** credential injection and route scoping per decision D-002: git fetch only (`git-receive-pack` always blocked), registry reads only, only the channel's repos.
