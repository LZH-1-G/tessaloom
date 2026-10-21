export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { parseWebEnv } = await import("@tessaloom/config/env");
    try {
      parseWebEnv(process.env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "web_config_invalid",
          message: (error as Error).message,
        }),
      );
      // Next otherwise keeps the listener open and serves 500s after hook failure.
      process.exit(1);
    }
  }
}
