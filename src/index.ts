#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import Fastify, { FastifyInstance } from "fastify";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const extenalQuickchart = process.env.QUICKCHART;
const masterIP = process.env.MASTER_IP;
const defaultQuickchartPort = 14166;
const flypassMCPQuickchartPort = 14167;
const QUICKCHART_BASE_URL = extenalQuickchart ? `${extenalQuickchart}/chart` : `http://${masterIP}:${defaultQuickchartPort}/chart`;
interface ChartConfig {
  type: string;
  data: {
    labels?: string[];
    datasets: Array<{
      label?: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  options?: {
    title?: {
      display: boolean;
      text: string;
    };
    scales?: {
      y?: {
        beginAtZero?: boolean;
      };
    };
    [key: string]: any;
  };
}

class QuickChartServer {
  private server: Server;
  private fastify: FastifyInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'quickchart-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.fastify = Fastify({
      requestTimeout: 0,
      keepAliveTimeout: 0,
      connectionTimeout: 0,
      disableRequestLogging: true,
      logger: {
        level: "debug",
        transport: {
          target: "pino-pretty", // 使用 pino-pretty 格式化输出
          options: {
            colorize: true, // 彩色输出
            translateTime: true, // 显示时间
            ignore: "pid,hostname,reqId", // 忽略特定字段
          },
        },
      },
    });

    this.fastify.register(import('fastify-raw-body'), {
      field: 'rawBody', // change the default request.rawBody property name
      global: true, // add the rawBody to every request. **Default true**
      encoding: false, // set it to false to set rawBody as a Buffer **Default utf8**
      runFirst: false, // get the body before any preParsing hook change/uncompress it. **Default false**
      routes: [], // array of routes, **`global`** will be ignored, wildcard routes not supported
      jsonContentTypes: [], // array of content-types to handle as JSON. **Default ['application/json']**
    })

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private validateChartType(type: string): void {
    const validTypes = [
      'bar', 'line', 'pie', 'doughnut', 'radar',
      'polarArea', 'scatter', 'bubble', 'radialGauge', 'speedometer'
    ];
    if (!validTypes.includes(type)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid chart type. Must be one of: ${validTypes.join(', ')}`
      );
    }
  }

  private generateChartConfig(args: any): ChartConfig {
    const { type, labels, datasets, title, options = {} } = args;

    this.validateChartType(type);

    const config: ChartConfig = {
      type,
      data: {
        labels: labels || [],
        datasets: datasets.map((dataset: any) => ({
          label: dataset.label || '',
          data: dataset.data,
          backgroundColor: dataset.backgroundColor,
          borderColor: dataset.borderColor,
          ...dataset.additionalConfig
        }))
      },
      options: {
        ...options,
        ...(title && {
          title: {
            display: true,
            text: title
          }
        })
      }
    };

    // Special handling for specific chart types
    switch (type) {
      case 'radialGauge':
      case 'speedometer':
        if (!datasets?.[0]?.data?.[0]) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `${type} requires a single numeric value`
          );
        }
        config.options = {
          ...config.options,
          plugins: {
            datalabels: {
              display: true,
              formatter: (value: number) => value
            }
          }
        };
        break;

      case 'scatter':
      case 'bubble':
        datasets.forEach((dataset: any) => {
          if (!Array.isArray(dataset.data[0])) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `${type} requires data points in [x, y${type === 'bubble' ? ', r' : ''}] format`
            );
          }
        });
        break;
    }

    return config;
  }

  private async generateChartUrl(config: ChartConfig): Promise<string> {
    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    return `${QUICKCHART_BASE_URL}?width=685&height=411&c=${encodedConfig}`;
  }
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'generate_chart',
          description: 'Generate a chart using QuickChart',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Chart type (bar, line, pie, doughnut, radar, polarArea, scatter, bubble, radialGauge, speedometer)'
              },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Labels for data points'
              },
              datasets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    data: { type: 'array' },
                    backgroundColor: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    borderColor: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    additionalConfig: { type: 'object' }
                  },
                  required: ['data']
                }
              },
              title: { type: 'string' },
              options: { type: 'object' }
            },
            required: ['type', 'datasets']
          }
        },
        {
          name: 'download_chart',
          description: 'Download a chart image to a local file',
          inputSchema: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                description: 'Chart configuration object'
              },
              outputPath: {
                type: 'string',
                description: 'Path where the chart image should be saved'
              }
            },
            required: ['config', 'outputPath']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'generate_chart': {
          try {
            const config = this.generateChartConfig(request.params.arguments);
            const url = await this.generateChartUrl(config);
            return {
              content: [
                {
                  type: 'text',
                  text: url
                }
              ]
            };
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to generate chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        case 'download_chart': {
          try {
            const { config, outputPath } = request.params.arguments as {
              config: Record<string, unknown>;
              outputPath: string;
            };
            const chartConfig = this.generateChartConfig(config);
            const url = await this.generateChartUrl(chartConfig);

            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const fs = await import('fs');
            await fs.promises.writeFile(outputPath, response.data);

            return {
              content: [
                {
                  type: 'text',
                  text: `Chart saved to ${outputPath}`
                }
              ]
            };
          } catch (error: any) {
            if (error instanceof McpError) {
              throw error;
            }
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to download chart: ${error?.message || 'Unknown error'}`
            );
          }
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async run() {
    const transports: { [sessionId: string]: SSEServerTransport } = {};
    this.fastify.get("/sse", async (_, reply) => {
      this.fastify.log.debug("sse");
      const transport = new SSEServerTransport('/messages', reply.raw);
      transports[transport.sessionId] = transport;
      reply.raw.on("close", () => {
        delete transports[transport.sessionId];
      });
      await this.server.connect(transport);
    });

    this.fastify.post("/messages", async (request, reply) => {
      this.fastify.log.debug("message");
      const query = request.query as { sessionId: string };
      const sessionId = query.sessionId;
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(request.raw, reply.raw, request.body);
      } else {
        return reply.status(400).send('No transport found for sessionId');
      }
    });

    this.fastify.listen(
      { port: flypassMCPQuickchartPort, host: "0.0.0.0" },
      (error) => {
        if (error) return error;
        this.fastify.log.info("quickchart/mcp server start success !");
      }
    );
  }
}

const server = new QuickChartServer();
server.run().catch(console.error);
