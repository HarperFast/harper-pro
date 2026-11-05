## Web Application Firewall

<VersionBadge version="v5.2.0" />

Operations for managing Web Application Firewall rules and cluster-wide enforcement controls.

Detailed documentation: [WAF Operations and Rule Schema](../web-application-firewall/operations.md)

| Operation        | Description                                       | Role Required |
| ---------------- | ------------------------------------------------- | ------------- |
| `add_waf_rule`   | Creates a validated WAF rule                      | super_user    |
| `alter_waf_rule` | Patches and revalidates an existing WAF rule      | super_user    |
| `drop_waf_rule`  | Deletes a WAF rule                                | super_user    |
| `list_waf_rules` | Returns all WAF rules                             | super_user    |
| `set_waf_mode`   | Sets the replicated mode and/or scoring threshold | super_user    |
