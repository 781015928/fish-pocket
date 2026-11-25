---
name: browser-cli
description: Operate the conversation's workbench browser, including forms, tabs and screenshots.
---

Use bash to run `browser open URL` and `browser read`. For a page that needs JavaScript, inspect its numbered controls, then use the latest number with `browser click 4`, `browser type 7 'some text'` or `browser select 2 'an option'`. Page actions return the updated page.

Run `browser tabs` to inspect which tab is in front, and `browser select_tab <id>` to bring a tab to the front. Actions default to the last tab used by the agent. The workbench shares sign-ins across conversations and keeps its own login state apart from Safari. Let the user enter passwords and payment details.

Use `browser help ACTION` for flags. Take a screenshot with `browser screenshot --out page.jpg`, then open it with `read_image`. For inline screenshots, PDF, upload or page JavaScript, enable `browser` with `connector_search(query="browser")` and call the structured tool.
