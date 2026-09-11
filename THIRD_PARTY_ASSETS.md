# Third-party assets

The web viewer includes board art from Colonist.

## Colonist board art

Colonist publishes its asset pack and board builder from its [press kit](https://colonist.io/press-kit). The files below were downloaded from `https://cdn.colonist.io/dist/assets/` on September 11, 2026.

| Local files              | Colonist source names                            |
| ------------------------ | ------------------------------------------------ |
| `tile-hill.svg`          | `generated_tile_brick.fd5dbb845772bdeba45b.svg`  |
| `tile-desert.svg`        | `generated_tile_desert.9e169062cabe58886069.svg` |
| `tile-field.svg`         | `generated_tile_grain.50fd57746befab85ea35.svg`  |
| `tile-forest.svg`        | `generated_tile_lumber.ce98887f6f467e76852f.svg` |
| `tile-mountain.svg`      | `generated_tile_ore.1b4024908dfb91c65232.svg`    |
| `tile-pasture.svg`       | `generated_tile_wool.29bcdda6873893e2a506.svg`   |
| `robber.svg`             | `icon_robber.2b909f277d60f24633e8.svg`           |
| `road-{color}.svg`       | `road_{color}.{content-hash}.svg`                |
| `settlement-{color}.svg` | `settlement_{color}.{content-hash}.svg`          |
| `city-{color}.svg`       | `city_{color}.{content-hash}.svg`                |

The four imported colors are red, blue, white, and orange. Colonist draws number tokens in its interface, so Catanarchy continues to draw accessible number text and probability pips over the imported tiles.

These files remain Colonist material and are not covered by Catanarchy's MIT license. The simulator, protocol, agents, and run files do not depend on this art. Models receive structured game state rather than these images.
