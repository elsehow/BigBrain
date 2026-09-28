// The workbench's skins folder (settings › themes): two skins a person wrote
// — one full (the shipped example), one minimal with every fallback taken
// — and one file that could not be read, so the screen's error list has
// something to show. Generated from lib/themes.ts readSkins() over real
// files; the css is what the engine would serve.
import type { SkinsReport } from "../lib/skins";

export const SKINS_DEMO: SkinsReport = 
{
  "dir": "/Users/demo/.config/bigbrain/themes",
  "skins": [
    {
      "id": "skin-gruvbox",
      "label": "Gruvbox",
      "scheme": "dark",
      "file": "gruvbox.yaml"
    },
    {
      "id": "skin-solarized-light",
      "label": "Solarized Light",
      "scheme": "light",
      "file": "solarized-light.yaml"
    }
  ],
  "css": "[data-theme=\"skin-gruvbox\"] { --bg: #282828; --fg: #ebdbb2; --activity: #fabd2f; color-scheme: dark; }\n[data-theme=\"skin-solarized-light\"] { --bg: #fdf6e3; --fg: #586e75; --activity: #dc322f; color-scheme: light; }",
  "errors": [
    {
      "file": "half-done.yaml",
      "error": "colors.activity is required"
    }
  ]
}
;
