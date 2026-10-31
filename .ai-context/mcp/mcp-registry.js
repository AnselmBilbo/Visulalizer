/**
 * MCP Registration Configuration
 * Place this in .ai-context/mcp/
 */
module.exports = {
    name: "design_assets_mcp",
    description: "Connects to external generation tools for UI, audio, or 3D rendering.",
    endpoint: "http://mcp-server.local:8080",
    tools: ["generate_svg_icon", "render_3d_element"]
};
