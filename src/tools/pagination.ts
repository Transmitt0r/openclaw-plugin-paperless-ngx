import { Type } from "typebox";

export const paginationParams = {
  page: Type.Optional(Type.Integer({ description: "Page number, 1-indexed." })),
  page_size: Type.Optional(
    Type.Integer({ description: "Results per page. Defaults to the server's page size." }),
  ),
};
