import { describe, expect, it } from "vitest";
import { MatrixError } from "./http.js";
import { AppserviceClient } from "./client.js";
import { bootstrapQueueRoom } from "./room.js";

const alias = "#queue:chat.example.org";
const mirrors = ["@mirror:example.org", "@mirror2:example.org"];

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

// A JSON round trip yields `any`, so the fake can answer for any T without a type assertion.
const reply = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));

function fakeClient(opts: {
  roomId?: string;
  members?: Array<[string, string]>;
}) {
  const calls: Call[] = [];
  class FakeClient extends AppserviceClient {
    override async request<T>(
      method: string,
      path: string,
      options: { body?: unknown } = {}
    ): Promise<T> {
      calls.push({ method, path, body: options.body });
      return reply<T>(await this.respond(method, path));
    }

    private async respond(method: string, path: string): Promise<unknown> {
      if (path.includes("/directory/room/") && method === "GET") {
        if (!opts.roomId)
          throw new MatrixError(404, "M_NOT_FOUND", {}, "no alias");
        return { room_id: opts.roomId };
      }
      if (path.endsWith("/members")) {
        return {
          chunk: (opts.members ?? []).map(([state_key, membership]) => ({
            state_key,
            content: { membership },
          })),
        };
      }
      if (path.endsWith("/createRoom")) return { room_id: "!new:example.org" };
      return {};
    }
  }
  const client = new FakeClient({
    baseUrl: "https://chat.example.org",
    asToken: "synthetic-token",
    sender: "@owner:example.org",
  });
  return { client, calls };
}

const invites = (calls: Call[]) =>
  calls.filter((c) => c.path.endsWith("/invite"));

describe("bootstrapQueueRoom", () => {
  it("invites nobody when the alias resolves and every mirror is a member", async () => {
    const { client, calls } = fakeClient({
      roomId: "!room:example.org",
      members: mirrors.map((m) => [m, "join"]),
    });

    const roomId = await bootstrapQueueRoom(client, {
      alias,
      mirrorUserIds: mirrors,
    });

    expect(roomId).toBe("!room:example.org");
    expect(invites(calls)).toEqual([]);
  });

  it("invites only the mirror that is missing when the alias resolves", async () => {
    const { client, calls } = fakeClient({
      roomId: "!room:example.org",
      members: [[mirrors[0]!, "join"]],
    });

    await bootstrapQueueRoom(client, { alias, mirrorUserIds: mirrors });

    expect(invites(calls).map((c) => c.body)).toEqual([
      { user_id: mirrors[1] },
    ]);
  });

  it("creates the room with the mirrors invited and registers the alias for a new room", async () => {
    const { client, calls } = fakeClient({});

    const roomId = await bootstrapQueueRoom(client, {
      alias,
      mirrorUserIds: mirrors,
    });

    expect(roomId).toBe("!new:example.org");
    const create = calls.find((c) => c.path.endsWith("/createRoom"));
    expect(create?.body).toMatchObject({ invite: mirrors });
    expect(
      calls.some(
        (c) => c.method === "PUT" && c.path.includes("/directory/room/")
      )
    ).toBe(true);
    expect(invites(calls)).toEqual([]);
  });
});
