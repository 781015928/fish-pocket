---
name: browser-cli
description: Use this conversation's iPhone or iPad browser to navigate interactive sites, click, fill forms, inspect tabs or take a screenshot.
---

Run `browser` through bash. `browser open URL` and `browser read` return the page with numbered elements. Use the latest numbers: `browser click 4`, `browser type 7 'some text'`, or `browser select 2 'an option'`. Each action returns the updated page. Use `browser tabs` and `browser help select_tab` to work with a particular tab. Sign-ins belong to the app's workbench browser. Leave passwords and payment details to the user.

Use `browser help ACTION` for flags. For a picture, run `browser screenshot --out page.jpg`, then use `read_image` on that file. For an inline screenshot or advanced operations such as PDF, upload, page JavaScript and downloads, use `connector_search` with the exact query `browser`, then call the structured tool. Use `web_fetch` for plain public page text.
