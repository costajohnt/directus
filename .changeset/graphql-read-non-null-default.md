---
'@directus/api': patch
---

Fixed non-nullable fields with a default value being typed as nullable in the GraphQL read schema, and fixed how `*` field permissions combine with narrower permissions on the same collection when deciding which GraphQL fields can be null
