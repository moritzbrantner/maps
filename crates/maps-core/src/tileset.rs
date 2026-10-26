//! Versioned vector source metadata. URLs are transport, never data identity.
use serde::{Deserialize, Serialize};

use crate::{RasterSourceSpec, TileId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapsTileset {
    pub version: u8,
    pub source_id: String,
    pub data_revision: String,
    pub format: String,
    pub schema: TilesetSchema,
    pub transport: TilesetTransport,
    pub projection: String,
    pub scheme: String,
    pub bounds: [f64; 4],
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub tile_size: u16,
    pub attribution: String,
    pub license: String,
    pub provenance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<TilesetObservation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TilesetSchema {
    pub id: String,
    pub version: String,
    pub source_layers: Vec<String>,
}

/// A future archive transport can extend this tagged boundary; no reader lives here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TilesetTransport {
    Xyz {
        #[serde(rename = "urlTemplate")]
        url_template: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TilesetObservation {
    pub snapshot: String,
    pub effective_date: Option<String>,
}

impl MapsTileset {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("unsupported Maps Tileset manifest version");
        }
        if [
            &self.source_id,
            &self.data_revision,
            &self.attribution,
            &self.license,
            &self.provenance,
        ]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 4096)
        {
            return Err(
                "Maps Tileset requires source ID, immutable revision, attribution, license and provenance",
            );
        }
        if self.format != "mvt" || self.projection != "web-mercator" || self.scheme != "xyz" {
            return Err("Maps Tileset supports only MVT XYZ in Web Mercator");
        }
        if self.schema.id != "shortbread"
            || self.schema.version != "1.0"
            || self.schema.source_layers.is_empty()
        {
            return Err("Maps Tileset requires compatible Shortbread 1.0 source layers");
        }
        let allowed = [
            "ocean",
            "water_polygons",
            "land",
            "sites",
            "buildings",
            "water_lines",
            "streets",
            "boundaries",
        ];
        if self.schema.source_layers.len() > allowed.len()
            || self
                .schema
                .source_layers
                .iter()
                .any(|layer| !allowed.contains(&layer.as_str()))
        {
            return Err("unsupported Shortbread source layer");
        }
        if RasterSourceSpec::new(self.min_zoom, self.max_zoom, self.tile_size).is_none()
            || ![256, 512].contains(&self.tile_size)
        {
            return Err("invalid Maps Tileset zoom or tile size");
        }
        let [west, south, east, north] = self.bounds;
        if !self.bounds.iter().all(|v| v.is_finite())
            || !(-180.0..=180.0).contains(&west)
            || !(-180.0..=180.0).contains(&east)
            || west == east
            || south >= north
            || south < -85.0511287798066
            || north > 85.0511287798066
        {
            return Err("invalid Maps Tileset coverage bounds");
        }
        let TilesetTransport::Xyz { url_template } = &self.transport;
        if url_template.len() > 8192
            || !["{z}", "{x}", "{y}"]
                .iter()
                .all(|token| url_template.contains(token))
            || !(url_template.starts_with("https://")
                || url_template.starts_with("http://")
                || url_template.starts_with('/'))
        {
            return Err(
                "Maps Tileset XYZ transport requires an HTTP(S) or root-relative template with z/x/y",
            );
        }
        if self.observation.as_ref().is_some_and(|o| {
            o.snapshot.trim().is_empty()
                || o.effective_date
                    .as_ref()
                    .is_some_and(|d| d.trim().is_empty())
        }) {
            return Err("invalid Maps Tileset observation metadata");
        }
        Ok(())
    }

    #[must_use]
    pub fn identity(&self) -> String {
        // JSON tuple avoids delimiter collisions. Neither transport nor observation/style belongs here.
        serde_json::to_string(&(
            &self.source_id,
            &self.data_revision,
            &self.schema.id,
            &self.schema.version,
            &self.schema.source_layers,
            self.min_zoom,
            self.max_zoom,
            self.tile_size,
            self.bounds,
        ))
        .expect("string tuple serializes")
    }

    #[must_use]
    pub fn source_spec(&self) -> RasterSourceSpec {
        RasterSourceSpec {
            min_zoom: self.min_zoom,
            max_zoom: self.max_zoom,
            tile_size: self.tile_size,
        }
    }

    #[must_use]
    pub fn covers(&self, tile: TileId) -> bool {
        let dimension = 2_f64.powi(i32::from(tile.z));
        let west = f64::from(tile.x) / dimension * 360.0 - 180.0;
        let east = (f64::from(tile.x) + 1.0) / dimension * 360.0 - 180.0;
        let latitude = |y: f64| {
            ((std::f64::consts::PI * (1.0 - 2.0 * y / dimension)).sinh())
                .atan()
                .to_degrees()
        };
        let north = latitude(f64::from(tile.y));
        let south = latitude(f64::from(tile.y) + 1.0);
        let [w, s, e, n] = self.bounds;
        south < n
            && north > s
            && if w < e {
                west < e && east > w
            } else {
                east > w || west < e
            }
    }
}
