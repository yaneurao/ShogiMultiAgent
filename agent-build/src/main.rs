#[path = "../../src/usi_agent.rs"]
mod usi_agent;
#[tokio::main]
async fn main() -> std::io::Result<()> {
    usi_agent::run_cli(std::env::args().skip(1)).await
}
