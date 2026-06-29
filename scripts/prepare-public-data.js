#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const FILES = [
  "KAPAL YG TERDETEKSI/scene_candidates_godark_spoofing_transshipment.csv",
  "KAPAL YG TERDETEKSI/scene_candidates_summary.csv",
  "new/metadata/ais_trajectory_points_raw_vs_kalman.csv",
  "Dataset_Test_Enriched/Dataset_Test_Enriched_EEZ_Indonesia/trajectory_outputs_25seq_windows_reference_style/ais_kalman_25seq_per_mmsi.csv",
  "new/metadata/metadata_with_vh_gfw_ais_identity_sog_cog_enriched_FINAL_kalman_estimated.csv",
  "new/metadata/metadata_with_vv_vh_gfw_ais_identity_sog_cog_enriched_ais_position_enriched_ais_latlon_formula_filled_kalman_estimated.csv",
  "data/local_kalman_trajectories.json",
];

const DIRECTORIES = [
  "KAPAL YG TERDETEKSI/SENTINEL1_SCENE_MAPS",
];

function srcPath(relativePath) {
  return path.join(ROOT, relativePath);
}

function destPath(relativePath) {
  return path.join(ROOT, "public", relativePath);
}

async function copyFile(relativePath) {
  const src = srcPath(relativePath);
  const dest = destPath(relativePath);

  if (!fs.existsSync(src)) {
    if (fs.existsSync(dest)) {
      console.log(`[public-data] keep existing ${relativePath}`);
      return { copied: 0, kept: 1, missing: 0 };
    }
    console.warn(`[public-data] missing ${relativePath}`);
    return { copied: 0, kept: 0, missing: 1 };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  console.log(`[public-data] copied ${relativePath}`);
  return { copied: 1, kept: 0, missing: 0 };
}

async function copyDirectory(relativePath) {
  const src = srcPath(relativePath);
  const dest = destPath(relativePath);

  if (!fs.existsSync(src)) {
    if (fs.existsSync(dest)) {
      console.log(`[public-data] keep existing directory ${relativePath}`);
      return { copied: 0, kept: 1, missing: 0 };
    }
    console.warn(`[public-data] missing directory ${relativePath}`);
    return { copied: 0, kept: 0, missing: 1 };
  }

  await copyDirectoryContents(src, dest);
  console.log(`[public-data] copied directory ${relativePath}`);
  return { copied: 1, kept: 0, missing: 0 };
}

async function copyDirectoryContents(srcDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;

    const srcStat = await fsp.stat(src);
    if (fs.existsSync(dest)) {
      const destStat = await fsp.stat(dest);
      if (destStat.size === srcStat.size) continue;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

function addStats(total, item) {
  total.copied += item.copied;
  total.kept += item.kept;
  total.missing += item.missing;
}

async function main() {
  const total = { copied: 0, kept: 0, missing: 0 };
  for (const file of FILES) addStats(total, await copyFile(file));
  for (const dir of DIRECTORIES) addStats(total, await copyDirectory(dir));

  console.log(`[public-data] summary copied=${total.copied} kept=${total.kept} missing=${total.missing}`);
  if (total.missing > 0) {
    console.warn("[public-data] some optional files are missing; dashboard will still build but those panels may be incomplete.");
  }
}

main().catch((err) => {
  console.error(`[public-data] failed: ${err?.message || err}`);
  process.exitCode = 1;
});
