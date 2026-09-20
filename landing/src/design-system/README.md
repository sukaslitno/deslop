# Landing design-system adapter

`generated-tokens.css` is a tracked snapshot of the `:root` block in
`app/src/design-system/tokens.css`. The prebuild sync refreshes it when the
shared source is present; an integrity-checked snapshot keeps a landing-only
Vercel build independent of the application directory.

`tokens.css` defines only the landing roles not exported by the app palette:
the black canvas and white Figma wordmark/text. They map to Figma desktop
nodes `411:1487`, `411:1498`, and `411:1500` and do not alter application
defaults.

Asset mapping: `public/brand/deslop-wordmark.svg` is the Figma export of
`411:1501`; `public/brand/disk-stats-drive.svg` comes from the supplied
application design-system asset; feature images are copied from the checked
landing reference package. The light SVGs preserve the implementation from
`app/src/components/scanning-glow.*`.
