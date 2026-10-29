export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export function badRequest(message) {
  return new HttpError(400, message);
}

export function unauthorized(message = "You need to sign in.") {
  return new HttpError(401, message);
}

export function forbidden(message = "You cannot do that.") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found.") {
  return new HttpError(404, message);
}
