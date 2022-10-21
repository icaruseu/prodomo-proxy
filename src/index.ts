import axios from "axios";
import cookieParser from "cookie-parser";
import express, { Request, Response } from "express";
import lz from "lz-ts";
import { createClient } from "redis";

type ExistResponse = {
  data: string | ArrayBuffer;
  headers: Record<string, string>;
};

const app = express();
app.use(cookieParser());

const port = process.env.PORT || 3000;

const existUrlBase =
  process.env.EXIST_URL_BASE || "http://localhost:8080/exist/apps/prodomo";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

const redisExpiry = Number(
  process.env.REDIS_EXPIRY_SEC || 60 * 60 * 24 * 7 * 4
);

const transport = axios.create({ withCredentials: true });

const prodomoCookies = ["ASPECTSORTING", "SORTING", "PERSONSORTING", "LANG"];

const prodomoHeaders = ["Content-Type", "Accept-Language"];

const redis = createClient({ url: redisUrl });
redis.on("error", (err) => console.log("Redis Client Error", err));
await redis.connect();

const redisKey = (existUrl: string, cookie: string) =>
  Buffer.from(`${existUrl}--${cookie}`).toString("base64");

const createExistUrl = (request: Request) => {
  let url = existUrlBase.replace("\\/$", "") + request.path;
  if (request.query) {
    url =
      url +
      "?" +
      Object.entries(request.query)
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
  }
  return url;
};

const extractCookies = (request: Request) => {
  const cookies: string[] = [];
  for (const name of prodomoCookies) {
    const value: undefined | string = request.cookies[name];
    if (value) {
      cookies.push(`${name}=${value}`);
    }
  }
  return cookies;
};

const serialize = ({ data, headers }: ExistResponse): string => {
  return lz.compress(
    JSON.stringify({
      headers,
      data: typeof data === "string" ? data : Array.from(new Uint8Array(data)),
    })
  );
};

const deserialize = (value: string, binary: boolean): ExistResponse => {
  const { headers, data } = JSON.parse(lz.decompress(value)) as Omit<
    ExistResponse,
    "data"
  > & { data: string | number[] };
  return {
    headers,
    data: binary
      ? Buffer.from(Uint8Array.from(data as number[]).buffer)
      : (data as string),
  };
};

const handleRequests = async (request: Request, response: Response) => {
  const cookie = extractCookies(request).join("; ");
  const existUrl = createExistUrl(request);
  const binary = /(png|jpe?g|tiff?|ttf|woff2?|ico)\??$/.test(existUrl);
  const key = redisKey(existUrl, cookie);
  let existResponse: ExistResponse;
  if (await redis.exists(key)) {
    const value = await redis.get(key);
    if (!value) {
      throw Error("Redis value is empty");
    }
    response.status(200);
    existResponse = deserialize(value, binary);
  } else {
    const { status, headers, data } = await transport
      .get(existUrl, {
        headers: {
          cookie: cookie || undefined,
        },
        responseType: binary ? "arraybuffer" : "json",
      })
      .then(
        ({ data, status, headers }) =>
          ({ data, status, headers } as ExistResponse & { status: number })
      )
      .catch(() => ({
        status: 404,
        headers: {},
        data: '<html><body>The page you are looking for can not found. Please click <a href="/">here</a> to return home.</body></html>',
      }));
    existResponse = { data, headers };
    if (status === 200) {
      redis.set(key, serialize(existResponse), { EX: redisExpiry });
    }
    response.status(status);
  }
  const { headers, data } = existResponse;
  prodomoHeaders.forEach((name) => {
    const value = headers[name] || headers[name.toLowerCase()];
    if (value) {
      response.setHeader(name, value.toString());
    }
  });
  if (binary) {
    response.end(data, "binary");
  } else {
    response.send(data);
  }
};

app.get("/robots.txt", function(_, res) {
  res.type("text/plain");
  res.send("User-agent: *\nDisallow: /search/");
});

app.get("*", handleRequests);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
