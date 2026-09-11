use std::{env, fs, process};

use maps_core::{EngineImplementationIdentity, execute_engine_scenario};

fn main() {
    if let Err(error) = run() {
        eprintln!("maps-engine-scenario: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args().skip(1);
    let scenario_path = arguments
        .next()
        .ok_or("usage: maps-engine-scenario <scenario.json>")?;
    if arguments.next().is_some() {
        return Err("usage: maps-engine-scenario <scenario.json>".into());
    }

    let scenario_json = fs::read_to_string(&scenario_path)?;
    let observation =
        execute_engine_scenario(&scenario_json, EngineImplementationIdentity::maps_rust())?;
    println!("{}", serde_json::to_string_pretty(&observation)?);

    Ok(())
}
