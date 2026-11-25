import McpResources from '@deepseek-ai/dsh-mcp-resources';

// A server can publish resources without publishing a single function. Follow the
// actual provider lifetime and scope so it remains discoverable after reconnect.
export default class IosMcpResources extends McpResources {
  register(server, provider) {
    const ctx = this.ctx;
    const register = () => super.register(server, provider);
    return ctx.effect(() => {
      const forget = ctx.tools.trackResource(server);
      try {
        const off = register();
        // Only the first and last provider change the upstream shared helper tools.
        ctx.emit('tools/change');
        return () => {
          forget();
          const result = off();
          ctx.emit('tools/change');
          return result;
        };
      } catch (error) {
        forget();
        throw error;
      }
    }, 'MCP resources and action directory');
  }
}
