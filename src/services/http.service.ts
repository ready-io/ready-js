import express, {Express, Response} from 'express';
import http, {Server} from 'http';
import bodyParser from 'body-parser';
import IO from 'socket.io';
import IORedis from 'socket.io-redis';
import got from 'got';
import LoggerService from './logger.service';
import PromClient from 'prom-client';
import {Subject} from 'rxjs';
import Service, {Inject} from './service';


type RouteHandler = ((res: Response, params: any, req: Request) => any) | Array<any> | string


class SocketsServerOptions
{
  enabled = false;
  redisHost: string;
  redisPort: number;
}


export class HttpServiceOptions
{
  port: number = 3000;
  socketsServer = new SocketsServerOptions();
  token: string = null;
  host: string = null;
}


@Inject()
export default class HttpService extends Service
{
  options = new HttpServiceOptions;
  express: Express;
  server: Server = null;
  protected deferred: any = {};
  io: IO.Server;
  PromClient = PromClient;
  protected metricsCollected = new Subject();


  constructor(protected logger: LoggerService)
  {
    super();
  }


  onInit()
  {
    const log = this.logger.action('HttpService.start');

    this.express  = express();

    // set up http server
    this.server = http.createServer(this.express);
    this.server.listen(this.options.port);

    // express configs
    this.express.use(bodyParser.json({ limit: '10mb' })); // support json encoded bodies
    this.express.use(bodyParser.urlencoded({ extended: true, limit: '10mb' })); // support encoded bodies
    this.express.use((req: any, _res, next) => // set params
    {
      req.parsed = {params: {}};

      for (var i in req.body)  { req.parsed.params[i] = req.body[i];  }
      for (var i in req.query) { req.parsed.params[i] = req.query[i]; }

      next();
    });

    this.setDefaultRoutes();
    log.info("HTTP server started");

    if (this.options.socketsServer.enabled)
    {
      this.startSocketsServer();
    }
  }


  setDefaultRoutes()
  {
    this.route("/ping", () =>
    {
      return 'pong';
    });

    this.route("/metrics", (res, params) =>
    {
      try
      {
        const promRegister = PromClient.register;

        res.set('Content-Type', promRegister.contentType);
        res.end(promRegister.metrics());

        const collect = typeof(params.collect) != 'undefined'? +params.collect: 1;

        if (collect)
        {
          this.metricsCollected.next();
        }
      }
      catch (ex)
      {
        res.status(500).end(ex);
      }

      return null;
    });
  }


  startSocketsServer()
  {
    const log     = this.logger.action('HttpService.startSocketsServer');
    const options = this.options.socketsServer;

    this.io = IO();
    this.io.attach(this.server);

    if (options.redisHost && options.redisPort)
    {
      this.io.adapter(IORedis({host: options.redisHost, port: options.redisPort}));
    }

    log.info("Sockets server started");
  }


  onStop()
  {
    const log = this.logger.action('HttpService.onStop');

    if (this.options.socketsServer.enabled)
    {
      this.io.close();
      log.info("Sockets server stopped");
    }

    this.server.close();
    log.info("HTTP server stopped");
  }


  route(route: string, handler: RouteHandler)
  {
    if (typeof(handler) == 'string')
    {
      this.express.use(route, express.static(handler));
      return;
    }

    const callback = async (req: any, res: Response) =>
    {
      let result: string;

      if (Array.isArray(handler))
      {
        const controller = handler[0];
        const method     = handler[1];

        result = await controller[method](res, req.parsed.params, req);
      }
      else
      {
        result = await handler(res, req.parsed.params, req);
      }

      if (result !== null)
      {
        res.send(result);
      }
    }

    this.express.route(route).get(callback).post(callback);
  }


  debounce(id: string, timeout: number, callback: () => {})
  {
    if (typeof(this.deferred[id]) != 'undefined') return;

    this.deferred[id] = setTimeout(() =>
    {
      delete this.deferred[id];
      callback();
    }, timeout);
  }


  get(url: string, params: any)
  {
    let params_str = ""

    params.token = this.options.token;

    if (params)
    {
      let params_arr = [];

      for (let name in params)
      {
        params_arr.push(`${name}=${params[name]}`);
      }

      params_str = params_arr.length? "?"+params_arr.join('&'): "";
    }

    const got_url = `http://${this.options.host}${url}${params_str}`;

    return got(got_url).json();
  }


  post(url: string, params: any)
  {
    params.token = this.options.token;

    url = `http://${this.options.host}${url}`;

    return got.post(url, {json: params}).json();
  }


  onMetricsCollected(callback: () => void)
  {
    this.metricsCollected.subscribe(callback);
  }
}
