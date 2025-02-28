import { bulkCreateLinks } from "@/lib/api/links";
import { qstash } from "@/lib/cron";
import { redis } from "@/lib/upstash";
import { sendEmail } from "@dub/email";
import { LinksImported } from "@dub/email/templates/links-imported";
import { prisma } from "@dub/prisma";
import { APP_DOMAIN_WITH_NGROK, linkConstructorSimple } from "@dub/utils";

// Function to sanitize strings with potentially malformed escape sequences
const sanitizeString = (
  str: string | null | undefined,
): string | null | undefined => {
  if (!str) return str;
  try {
    // Check if the string contains any potentially problematic escape sequences
    const problematicEscapeRegex =
      /\\(u[0-9a-fA-F]{0,3}|x[0-9a-fA-F]?)(?![0-9a-fA-F])/g;

    if (problematicEscapeRegex.test(str)) {
      console.log(`Found problematic escape sequence in string: ${str}`);

      // Log each problematic escape sequence
      let match;
      problematicEscapeRegex.lastIndex = 0; // Reset regex state
      while ((match = problematicEscapeRegex.exec(str)) !== null) {
        console.log(
          `Problematic escape at position ${match.index}: ${match[0]}`,
        );
      }
    }

    // Reset regex state
    problematicEscapeRegex.lastIndex = 0;

    // Replace any potentially problematic escape sequences
    return str.replace(
      problematicEscapeRegex,
      // Replace with the literal characters
      (match) => match.replace("\\", "\\\\"),
    );
  } catch (e) {
    // If string processing fails, return a sanitized version
    console.error(`Error sanitizing string: ${e}`);
    return str.replace(/\\/g, "\\\\"); // Double escape all backslashes
  }
};

// Note: rate limit for /groups/{group_guid}/bitlinks is 1500 per hour or 150 per minute
export const importLinksFromBitly = async ({
  workspaceId,
  userId,
  bitlyGroup,
  domains,
  folderId,
  tagsToId,
  bitlyApiKey,
  searchAfter = null,
  count = 0,
}: {
  workspaceId: string;
  userId: string;
  bitlyGroup: string;
  domains: string[];
  folderId?: string;
  tagsToId?: Record<string, string>;
  bitlyApiKey: string;
  searchAfter?: string | null;
  count?: number;
}) => {
  const data = await fetch(
    `https://api-ssl.bitly.com/v4/groups/${bitlyGroup}/bitlinks?size=100${
      searchAfter ? `&search_after=${searchAfter}` : ""
    }`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bitlyApiKey}`,
      },
    },
  ).then((res) => res.json());
  const { links, pagination } = data;
  const nextSearchAfter = pagination.search_after;

  // convert links to format that can be imported into database
  const importedLinks = links.flatMap(
    ({
      id,
      long_url: url,
      title,
      archived,
      created_at,
      custom_bitlinks,
      tags,
    }) => {
      if (!id || !url) {
        return [];
      }
      const [domain, key] = id.split("/");
      // if domain is not in workspace domains, skip (could be a bit.ly link or old short domain)
      if (!domains.includes(domain)) {
        return [];
      }

      // Sanitize the URL and skip if it becomes empty after sanitization
      const sanitizedUrl = sanitizeString(url) || "";
      if (sanitizedUrl === "") {
        console.log(`Skipping link with empty URL after sanitization: ${id}`);
        return [];
      }

      const createdAt = new Date(created_at).toISOString();
      const tagIds = tagsToId ? tags.map((tag: string) => tagsToId[tag]) : [];
      const linkDetails = {
        projectId: workspaceId,
        userId,
        domain,
        key,
        url: sanitizedUrl,
        shortLink: linkConstructorSimple({
          domain,
          key,
        }),
        title: sanitizeString(title),
        archived,
        createdAt,
        tagIds,
        folderId,
      };

      return [
        linkDetails,
        // if link has custom bitlinks, add them to the list of links to import
        ...(custom_bitlinks
          ?.filter((customBitlink: string) => {
            try {
              const customDomain = new URL(customBitlink).hostname;
              // only import custom bitlinks that have the same domain as the domains
              // that were previously imported into the workspace from bitly
              return domains.includes(customDomain);
            } catch (e) {
              console.error(
                `Invalid custom bitlink, skipping: ${customBitlink}`,
              );
              return false;
            }
          })
          .map((customBitlink: string) => {
            try {
              // here we are getting the customDomain again just in case
              // the custom bitlink doesn't have the same domain as the
              // original bitlink, but it should
              const customDomain = new URL(customBitlink).hostname;
              const customKey = new URL(customBitlink).pathname.slice(1);

              // Create a copy with the new domain and key
              return {
                ...linkDetails,
                domain: customDomain,
                key: customKey,
                shortLink: linkConstructorSimple({
                  domain: customDomain,
                  key: customKey,
                }),
              };
            } catch (e) {
              console.error(
                `Error processing custom bitlink, skipping: ${customBitlink}`,
              );
              return null;
            }
          })
          .filter(Boolean) ?? []),
      ];
    },
  );

  // check if links are already in the database
  const alreadyCreatedLinks = await prisma.link.findMany({
    where: {
      shortLink: {
        in: importedLinks.map((link) => link.shortLink),
      },
    },
    select: {
      shortLink: true,
    },
  });

  // filter out links that are already in the database
  const linksToCreate = importedLinks.filter(
    (link) => !alreadyCreatedLinks.some((l) => l.shortLink === link.shortLink),
  );

  console.log(
    `Found ${alreadyCreatedLinks.length} links that have already been imported, skipping them and creating ${linksToCreate.length} new links...`,
  );

  // bulk create links
  await bulkCreateLinks({ links: linksToCreate });

  count += importedLinks.length;

  console.log({
    importedLinksLength: importedLinks.length,
    count,
    nextSearchAfter,
  });

  // wait 500 ms before making another request
  await new Promise((resolve) => setTimeout(resolve, 500));

  if (nextSearchAfter === "") {
    const workspace = await prisma.project.findUnique({
      where: {
        id: workspaceId,
      },
      select: {
        name: true,
        slug: true,
        users: {
          where: {
            role: "owner",
          },
          select: {
            user: {
              select: {
                email: true,
              },
            },
          },
        },
        links: {
          select: {
            domain: true,
            key: true,
            createdAt: true,
          },
          where: {
            domain: {
              in: domains,
            },
          },
          take: 5,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });
    const ownerEmail = workspace?.users[0].user.email ?? "";
    const links = workspace?.links ?? [];

    await Promise.all([
      // delete keys from redis
      redis.del(`import:bitly:${workspaceId}`),
      redis.del(`import:bitly:${workspaceId}:tags`),

      // delete tags that have no links
      prisma.tag.deleteMany({
        where: {
          projectId: workspaceId,
          links: {
            none: {},
          },
        },
      }),

      // send email to user
      sendEmail({
        subject: `Your Bitly links have been imported!`,
        email: ownerEmail,
        react: LinksImported({
          email: ownerEmail,
          provider: "Bitly",
          count,
          links,
          domains,
          workspaceName: workspace?.name ?? "",
          workspaceSlug: workspace?.slug ?? "",
        }),
      }),
    ]);
    return count;
  } else {
    return await qstash.publishJSON({
      url: `${APP_DOMAIN_WITH_NGROK}/api/cron/import/bitly`,
      body: {
        workspaceId,
        userId,
        bitlyGroup,
        domains,
        folderId,
        importTags: tagsToId ? true : false,
        searchAfter: nextSearchAfter,
        count,
      },
    });
  }
};
