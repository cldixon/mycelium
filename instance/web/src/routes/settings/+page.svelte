<script lang="ts">
  import { goto, invalidate } from "$app/navigation";
  import {
    Actor,
    Button,
    CopyButton,
    Field,
    Loading,
    MetaList,
    Notice,
    PageHeader,
    Section,
    formatDate,
  } from "@mycelium/ui";
  import type { ApiTokenInfo, InstanceSettings } from "$shared/types";
  import { auth } from "$lib/api";
  import { mcpSetup, settings, TOKEN_LIFETIMES } from "$lib/settings";

  let { data } = $props();

  let signedIn = $derived(data.status?.signedIn ?? false);
  let info = $state<InstanceSettings | null>(null);
  let tokens = $state<ApiTokenInfo[]>([]);
  let tokenName = $state("");
  let tokenDays = $state(90);
  let tokenAgent = $state("");
  let tokenScope = $state<"read" | "write">("write");
  let newToken = $state<{ name: string; token: string; agent: string | null } | null>(null);
  let setup = $derived(newToken ? mcpSetup(location.origin, newToken.token) : null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (signedIn) void load();
  });

  async function load() {
    try {
      [info, tokens] = await Promise.all([settings.get(), settings.tokens()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function run(work: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await work();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const createToken = () =>
    run(async () => {
      const name = tokenName.trim();
      const created = await settings.createToken({
        name,
        days: tokenDays,
        agent: tokenAgent.trim() || null,
        scope: tokenScope,
      });
      newToken = { name, token: created.token, agent: created.apiToken.agent };
      tokenName = "";
      tokenAgent = "";
      tokens = await settings.tokens();
    });

  function revokeToken(t: ApiTokenInfo) {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
    return run(async () => {
      await settings.revokeToken(t.id);
      tokens = await settings.tokens();
    });
  }

  const signOut = () =>
    run(async () => {
      await auth.logout();
      await invalidate("mycelium:session");
      await goto("/");
    });
</script>

<svelte:head><title>Settings · {data.status?.title ?? "mycelium"}</title></svelte:head>

<div class="grid max-w-reading gap-10">
  <PageHeader title="Settings" description="API tokens, owner and this instance." />

  {#if !signedIn}
    <Notice title="Sign in to see this instance's settings">
      Only the owner can manage the instance. <a href="/signin">Sign in</a>
    </Notice>
  {:else}
    {#if error}<Notice tone="error">{error}</Notice>{/if}

    {#if !info}
      {#if !error}<Loading />{/if}
    {:else}
      <Section
        id="tokens"
        title="API tokens"
        description="For scripts and agents: send Authorization: Bearer <token> to /api or connect an MCP client to /mcp. A token can do anything you can here except manage tokens (a read token only reads), and it always expires. Name an agent and what the token does is shown as that agent's."
      >
        {#if newToken}
          <Notice tone="success" title="Copy “{newToken.name}” now. It won't be shown again.">
            <code class="data break-all select-all" data-testid="new-token">{newToken.token}</code>
            {#snippet actions()}
              <CopyButton value={newToken!.token} label="copy token" />
              <Button size="sm" variant="quiet" onclick={() => (newToken = null)}>done</Button>
            {/snippet}
          </Notice>
          {#if setup}
            <div class="grid gap-3" data-testid="mcp-setup">
              <p class="text-meta">
                Connect {#if newToken.agent}<Actor name={newToken.agent} kind="agent" />{:else}an
                  MCP client{/if} to <code class="data">{setup.url}</code> with the header
                <code class="data">Authorization: Bearer …</code>.
              </p>
              <Field label="Claude Code">
                <pre
                  class="data border border-line p-2 break-all whitespace-pre-wrap">{setup.claudeCode}</pre>
              </Field>
              <div><CopyButton value={setup.claudeCode} label="copy command" /></div>
              <Field label="MCP client config (JSON)">
                <pre class="data overflow-x-auto border border-line p-2">{setup.json}</pre>
              </Field>
              <div><CopyButton value={setup.json} label="copy config" /></div>
            </div>
          {/if}
        {/if}

        {#if tokens.length > 0}
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>name</th><th>agent</th><th>scope</th><th>token</th><th>created</th><th
                    >expires</th
                  ><th>last used</th><th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {#each tokens as t (t.id)}
                  <tr>
                    <td>{t.name}</td>
                    <td class="nowrap">
                      {#if t.agent}<Actor name={t.agent} kind="agent" />{:else}<span
                          class="text-muted">owner</span
                        >{/if}
                    </td>
                    <td class="data nowrap">{t.scope}</td>
                    <td class="data nowrap">{t.prefix}…</td>
                    <td class="data nowrap">{formatDate(t.createdAt)}</td>
                    <td class="data nowrap">{formatDate(t.expiresAt)}</td>
                    <td class="data nowrap">{t.lastUsedAt ? formatDate(t.lastUsedAt) : "never"}</td>
                    <td class="num">
                      <Button
                        size="sm"
                        variant="quiet"
                        disabled={busy}
                        aria-label="Revoke {t.name}"
                        onclick={() => revokeToken(t)}>revoke</Button
                      >
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-meta text-muted">No API tokens.</p>
        {/if}

        <form
          class="flex flex-wrap items-end gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            void createToken();
          }}
        >
          <div class="flex-1">
            <Field label="Name">
              <input
                class="input"
                bind:value={tokenName}
                placeholder="laptop script"
                maxlength="100"
                required
              />
            </Field>
          </div>
          <div class="flex-1">
            <Field label="Agent (optional)">
              <input class="input" bind:value={tokenAgent} placeholder="claude-1" maxlength="39" />
            </Field>
          </div>
          <Field label="Access">
            <select class="input" bind:value={tokenScope}>
              <option value="write">read and write</option>
              <option value="read">read only</option>
            </select>
          </Field>
          <Field label="Expires in">
            <select class="input" bind:value={tokenDays}>
              {#each TOKEN_LIFETIMES as [days, label] (days)}
                <option value={days}>{label}</option>
              {/each}
            </select>
          </Field>
          <Button type="submit" disabled={busy || !tokenName.trim()}>Create token</Button>
        </form>
      </Section>

      <Section id="owner" title="Owner">
        <MetaList
          rows={[
            {
              label: "Handle",
              value: info.owner.handle ? `@${info.owner.handle}` : "(unresolved)",
            },
            { label: "DID", value: info.owner.did, mono: true },
          ]}
        />
        <p class="text-meta text-muted">
          Ownership is tied to this AT Protocol account. Transferring an instance isn't supported
          yet.
        </p>
        <div><Button onclick={signOut} disabled={busy}>Sign out</Button></div>
      </Section>

      <Section id="instance" title="Instance">
        <MetaList
          rows={[
            { label: "Title", value: info.title },
            { label: "Version", value: info.version, mono: true },
            {
              label: "Push events",
              value: info.pushEvents
                ? "On: pushes start workflows and update pull requests"
                : "Off: no CF_API_TOKEN secret, so run workflows by hand",
            },
          ]}
        />
        <p class="text-meta text-muted">
          The title and domain come from <code class="data">mycelium.config.json</code>; change them
          with <code class="data">mycelium setup</code> and deploy again. Push events need a
          Cloudflare API token: <code class="data">mycelium secrets cf-api-token</code>.
        </p>
      </Section>
    {/if}
  {/if}
</div>
