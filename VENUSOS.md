# Saillogger for Venus OS

This plugin provides specialized support for Venus OS for easier configuration.

While running on Venus OS, this extension allows Saillogger.com to configure the plugin automatically through a web server that the plugin spins up on port 1977. This web server is disabled upon successful configuration of the plugin. When up and running, this web server can only be used to set the Collector ID for the plugin through a single API endpoint, and is only accessible through Saillogger.com (ensured through CORS headers). It cannot be used by other sites or pages nor can it be used to configure anything other than the Collector ID for the Saillogger plugin.
