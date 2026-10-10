# Skins

The app leads with three themes that follow the system's light or dark
appearance: **Ink** (the default), white by day and a plum-black by night;
**Kind of Blue**, a pale paper by day and a deep blue by night; and
**Something's Gotta Give**, cream by day and Hampton's Nights, a soft
Solarized-style slate, by night. Single themes follow: **OG Web Blue**,
**Spring**, **Fall**, **Winter**, **Jodie Foster in Contact**, and
**A Love Supreme**.
Every palette defines just three colors: background, foreground, and activity.
Muted text, borders and surfaces derive from background and foreground.
Selection inverts those two colors for regular and closed nodes. Active
processes (currently Pilot sessions) use the accent for their indicator; a
selected active row uses the accent as its background with contrasting text
and indicator.

A custom skin is a YAML file in `~/.config/bigbrain/themes/`. Save it and
select it in **settings › themes**. No restart or rebuild.
**WRITE EXAMPLE SKIN** creates `solarized-light.yaml` to copy;
**OPEN FOLDER** reveals the folder.

```yaml
name: Solarized Light
scheme: light             # optional: light | dark, otherwise inferred from bg
colors:
  bg: "#fdf6e3"
  text: "#586e75"
  activity: "#dc322f"
fonts:                    # optional
  app: "Hanken Grotesk, system-ui, sans-serif"
  mono: "ui-monospace, Menlo, monospace"
```

Required: `name`, `colors.bg`, `colors.text`, and `colors.activity`.
Colors can be hex, `rgb()` / `hsl()` / `oklch()`, or CSS color names.
Older skins still load: the first `colors.accents` entry becomes activity
when `colors.activity` is absent. Old neutral overrides and the remaining
accents are ignored, so old files also paint with only three base colors.

The filename determines the skin's id. `My Skin.yaml` and `my-skin.yml`
produce the same id; the second is reported as a duplicate. Custom skins
have a `skin-` prefix, so they cannot replace built-ins.

Unreadable skins appear with their filename and error on the themes screen.
Fix the file and refocus the window to reload. A missing selected skin
falls back to the system until its file returns. Choices live in this
machine's browser storage, separate from vault content.
