import { route } from "../../../server/http";

export const GET = route(async ({ principal }) => principal);
