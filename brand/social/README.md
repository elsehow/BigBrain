# Social artwork

- `avatar-blue.png`: 1024 × 1024 cube avatar for the BigBrain accounts.
- `avatar-light.png`: the same artwork in the Light palette.
- `x-banner-blue.png`: 1500 × 500 X header. The lower-left area is left clear for the profile-photo overlap.

These are PNG stills of the actual cube from `docs/design/mark/bigbrain-cube.html`, paused 285ms into its first turn. They use the site's palette mapping and the app's OG web blue / Light colors. Avatar artwork fits within a circular crop. Existing email assets are untouched.

To re-export using Playwright and installed Google Chrome:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node brand/social/render.cjs
```

X's size guidance: https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo.html
