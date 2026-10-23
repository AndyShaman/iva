# IVA brand

The logo is two leaves and the word **IVA**. All files live in [`docs/brand/`](brand/) and are served at `https://iva-agent.com/brand/…`. Every SVG is paths only: no fonts, no `<text>`, no effects.

## Colors

| Role                          | Hex                   | Where                                |
| ----------------------------- | --------------------- | ------------------------------------ |
| Large left leaf               | `#A4DC55`             | every color variant, favicon         |
| Small right leaf              | `#368AD2`             | every color variant, favicon         |
| Letters on a light background | `#1A2327`             | `logo-light`                         |
| Letters on a dark background  | `#E3E8EC`             | `logo-dark`                          |
| Monochrome                    | `#000000` / `#FFFFFF` | `logo-mono-black`, `logo-mono-white` |

The small leaf always sits on top of the large one.

## Variants

| File                                          | Use it on                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `logo-light.svg` (`.png`, `@2x.png`)          | white or light backgrounds: README in light theme, documents, light OG card |
| `logo-dark.svg` (`.png`, `@2x.png`)           | black or dark backgrounds: the website, README in dark theme, dark OG card  |
| `logo-mono-black.svg` / `logo-mono-white.svg` | one-color printing, stamps, embossing, places where color is not available  |
| `mark.svg` (`mark-180.png`, `mark-512.png`)   | the two leaves alone: favicon, app icon, avatar, very small sizes           |
| `mark-mono-black.svg` / `mark-mono-white.svg` | the leaves alone in one color                                               |
| `og-light.png`, `og-dark.png`, `og-*-ru.png`  | link previews and the GitHub social preview, 1280×640                       |

Site icons at the site root: `favicon.svg`, `favicon.ico` (16, 32, 48), `favicon-32.png`, `favicon-192.png`, `favicon-512.png`, `apple-touch-icon.png` (180, white tile).

The monochrome version draws the leaves with a gap between them; use its own files, do not recolor the color version.

## Clear space and size

- Clear space around the full logo: at least half the height of the letters IVA on every side. Nothing else (text, edges, other marks) goes inside it.
- Smallest full logo: 96 px wide on screen, 25 mm in print. Below that use the leaves alone.
- Smallest leaves alone: 16 px.

## Do not

- Recolor the leaves, swap their colors, add gradients, outlines or shadows.
- Stretch, squash, rotate or skew the logo; scale only proportionally.
- Retype the word IVA in another font or rebuild it from text: use the files.
- Move the leaves relative to the letters or change the spacing between the letters.
- Put `logo-light` on a dark background or `logo-dark` on a light one.
- Place the logo on a busy photo without a calm area under it.

## Source

The letters come from Benzin Semibold (Supremat), converted to outlines. The font file itself is not part of this repository and is not needed to use the logo.
