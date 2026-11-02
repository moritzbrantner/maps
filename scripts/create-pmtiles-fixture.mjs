/** Reproduce the committed PMTiles v3 fixture with go-pmtiles >=1.31.2.
 *  Usage: PMTILES_CLI=/path/to/pmtiles node scripts/create-pmtiles-fixture.mjs
 *  The geometry is synthetic CC0; no geographic dataset or network is needed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { createShortbreadTileFixture } from "../e2e/fixtures/shortbread-tile.mjs";

const cli = process.env.PMTILES_CLI ?? "pmtiles";
const work = mkdtempSync(join(tmpdir(), "maps-pmtiles-fixture-"));
const archive = new URL("../public/tilesets/fixture-pmtiles-v1.pmtiles", import.meta.url);
const rawTile = new URL("../public/tilesets/fixture-pmtiles-v1.mvt", import.meta.url);
const showcaseArchive = new URL("../public/tilesets/showcase-pmtiles-v1.pmtiles", import.meta.url);
const metadata = {
  name: "Maps deterministic Shortbread PMTiles fixture",
  description: "Synthetic island hole and street lines; CC0, not geographic data",
  format: "pbf",
  bounds: "-180,-85.0511288,180,85.0511288",
  center: "0,0,0",
  minzoom: "0",
  maxzoom: "1",
  json: JSON.stringify({
    vector_layers: ["water_polygons", "land", "streets"].map((id) => ({ id, fields: {} })),
  }),
};
const tile = createShortbreadTileFixture({
  dense: true,
  streetRows: 128,
  pointsPerStreet: 256,
  streetJitter: 8,
});
const db = new DatabaseSync(join(work, "fixture.mbtiles"));
try {
  db.exec("CREATE TABLE metadata (name TEXT, value TEXT)");
  db.exec(
    "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)",
  );
  const insertMetadata = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  for (const [name, value] of Object.entries(metadata)) insertMetadata.run(name, value);
  const insertTile = db.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
  insertTile.run(0, 0, 0, gzipSync(tile));
  // Only one z1 quadrant exists, making absent-tile failure testable.
  insertTile.run(
    1,
    0,
    1,
    gzipSync(
      createShortbreadTileFixture({
        dense: true,
        streetRows: 128,
        pointsPerStreet: 256,
        streetJitter: 8,
        islandWest: 1350,
      }),
    ),
  );
} finally {
  db.close();
}
// The public engine needs an uninterrupted, pan-safe synthetic map, while the
// original sparse archive above deliberately retains a missing tile for tests.
// Neither artifact represents real-world geography (Atlas #270 owns that).
const showcaseDb = new DatabaseSync(join(work, "showcase.mbtiles"));
try {
  showcaseDb.exec("CREATE TABLE metadata (name TEXT, value TEXT)");
  showcaseDb.exec(
    "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)",
  );
  const insertMetadata = showcaseDb.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  for (const [name, value] of Object.entries({
    ...metadata,
    name: "Maps first-party engine synthetic showcase",
    description: "Complete z0–z2 coverage, synthetic CC0 geometry; not a geographic basemap",
    maxzoom: "2",
  })) {
    insertMetadata.run(name, value);
  }
  const insertTile = showcaseDb.prepare("INSERT INTO tiles VALUES (?, ?, ?, ?)");
  for (let z = 0; z <= 2; z += 1) {
    const dimension = 2 ** z;
    for (let x = 0; x < dimension; x += 1) {
      for (let y = 0; y < dimension; y += 1) {
        // MBTiles uses TMS tile rows; Maps' public source uses XYZ rows.
        const tmsY = dimension - 1 - y;
        const mvt =
          z === 0
            ? tile
            : createShortbreadTileFixture({
                dense: true,
                streetRows: 56,
                pointsPerStreet: 192,
                streetJitter: 8,
                islandWest: 700 + ((x * 191 + y * 137 + z * 79) % 570),
                islandEast: 3240 - ((x * 71 + y * 163 + z * 37) % 410),
              });
        insertTile.run(z, x, tmsY, gzipSync(mvt));
      }
    }
  }
} finally {
  showcaseDb.close();
}
try {
  execFileSync(cli, ["convert", join(work, "fixture.mbtiles"), join(work, "fixture.pmtiles")], {
    stdio: "inherit",
  });
  writeFileSync(archive, readFileSync(join(work, "fixture.pmtiles")));
  writeFileSync(rawTile, tile);
  execFileSync(cli, ["verify", archive.pathname], { stdio: "inherit" });
  execFileSync(cli, ["convert", join(work, "showcase.mbtiles"), join(work, "showcase.pmtiles")], {
    stdio: "inherit",
  });
  writeFileSync(showcaseArchive, readFileSync(join(work, "showcase.pmtiles")));
  execFileSync(cli, ["verify", showcaseArchive.pathname], { stdio: "inherit" });
} finally {
  rmSync(work, { recursive: true, force: true });
}
