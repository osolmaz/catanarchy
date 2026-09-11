# Third-party assets

The web viewer includes board art from Colonist.

## Colonist board art

Colonist publishes its [asset pack](https://tinyurl.com/Colonist-Assets) and [Board Builder](https://www.figma.com/community/file/1222835270932934554/colonist-io-board-builder) from its [press kit](https://colonist.io/press-kit).

The terrain, robber, road, settlement, and city files were downloaded from `https://cdn.colonist.io/dist/assets/` on September 11, 2026.

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

The four piece colors are red, blue, white, and orange.

The number, shore, dock, and port files were exported from the official Colonist Board Builder Figma file on September 11, 2026.

| Local files          | Figma components                         |
| -------------------- | ---------------------------------------- |
| `number-{2..12}.svg` | Probability tokens, except seven         |
| `shore-{2,3}-*.svg`  | Two-edge and three-edge shore rotations  |
| `dock-*.svg`         | Six dock orientations                    |
| `port-{kind}.svg`    | Five resource ports and the generic port |

The Board Builder identifies Demi Yilmaz as its creator and is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The exported SVG files keep the component geometry, colors, and labels from that source.

These files remain Colonist material and are not covered by Catanarchy's MIT license. The simulator, protocol, agents, and run files do not depend on this art. Models receive structured game state rather than these images.
