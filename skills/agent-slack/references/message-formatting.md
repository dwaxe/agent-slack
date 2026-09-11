# Format Slack messages

- Labeled links may use Markdown (`[label](https://example.com)`) or Slack mrkdwn (`<https://example.com|label>`); `message send` and `message edit` normalize both, including links in lists.
- Ordinary `message send` and `message edit` convert common bullet and numbered lists to Slack-native rich text. Within generated rich-text blocks, `:emoji:` shortcodes, `<@U...>` people, `<#C...>` channels, `<!subteam^S...>` user groups, `<!here>`/`<!channel>`/`<!everyone>`, inline styles, code, quotes, and Slack manual links become native elements.
- `message send --blocks <path>` and `message edit --blocks <path>` use the supplied Block Kit array instead of automatic conversion. The positional text remains the fallback for notifications and unfurls. Send-side `--blocks` cannot be combined with `--attach`.
- `message send --attach` sends the first file's initial comment as plain text without automatic list conversion. Attachments cannot be scheduled or combined with `--reply-broadcast`.
- `--reply-broadcast` requires thread context, is unavailable for DM targets, and cannot be combined with attachments.
- Read `mentions.md` for person or user-group notifications.
- After a send, inspect its returned permalink when present; otherwise verify from returned channel/timestamp or scheduled metadata. After an edit, re-read the exact target. `ok: true` confirms the API action only.
