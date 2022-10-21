import express, { Request, Response } from "express";
import axios, { AxiosHeaders } from "axios";
import cookieParser from "cookie-parser";

const app = express();
app.use(cookieParser());

const port = process.env.PORT || 3000;

const existUrlBase =
  process.env.EXIST_URL_BASE || "http://localhost:8080/exist/apps/prodomo";

const transport = axios.create({ withCredentials: true });

const addResponseHeaders = (headers: AxiosHeaders, response: Response) => {
  response
    .setHeader(
      "content-type",
      headers.get("content-type")?.toString() || "text/html"
    )
    .setHeader(
      "content-length",
      headers.get("content-length")?.toString() || ""
    );
};

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

const handleRequests = async (request: Request, response: Response) => {
  const cookie = Object.entries(request.cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  const existUrl = createExistUrl(request);
  const binary = /png|jpe?g|tiff?|ttf|woff2?$/.test(existUrl);
  await transport
    .get(existUrl, {
      headers: {
        cookie: cookie || undefined,
      },
      responseType: binary ? "arraybuffer" : undefined,
    })
    .then(({ status, headers, data }) => {
      response.status(status);
      addResponseHeaders(headers as AxiosHeaders, response);
      if (binary) {
        response.end(data, "binary");
      } else {
        response.send(data);
      }
    })
    .catch((e) => {
      response.status(e.response.status).send(e.response.message);
    });
};

app.get("/robots.txt", function(_, res) {
  res.type("text/plain");
  res.send("User-agent: *\nDisallow: /search/");
});

app.get("*", handleRequests);

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
