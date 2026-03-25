import { createContext, useContext, useEffect, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import {
  createImageBlockConfig,
  imageParse,
} from "@blocknote/core";

export const ImageResolverContext = createContext<{ notePath: string }>({
  notePath: "",
});

function toCollabFileUrl(absolutePath: string): string {
  return `collab-file://${encodeURIComponent(absolutePath).replace(/%2F/g, "/")}`;
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isCollabFileUrl(url: string): boolean {
  return url.startsWith("collab-file://");
}

function isWikiImageUrl(url: string): boolean {
  return url.startsWith("wikiimage:");
}

function extractWikiImageRef(url: string): string {
  const raw = url.slice("wikiimage:".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type ResolvedState =
  | { status: "loading" }
  | { status: "resolved"; src: string }
  | { status: "error"; reference: string };

function useResolvedImageUrl(
  url: string,
  notePath: string,
): ResolvedState {
  const [state, setState] = useState<ResolvedState>(() => {
    if (!url) return { status: "error", reference: "" };
    if (isExternalUrl(url) || isCollabFileUrl(url)) {
      return { status: "resolved", src: url };
    }
    return { status: "loading" };
  });

  useEffect(() => {
    if (!url) {
      setState({ status: "error", reference: "" });
      return;
    }
    if (isExternalUrl(url) || isCollabFileUrl(url)) {
      setState({ status: "resolved", src: url });
      return;
    }

    setState({ status: "loading" });
    let cancelled = false;
    const reference = isWikiImageUrl(url)
      ? extractWikiImageRef(url)
      : url;

    if (!notePath) {
      setState({ status: "error", reference });
      return;
    }

    window.api
      .resolveImagePath(reference, notePath)
      .then((resolved) => {
        if (cancelled) return;
        if (resolved) {
          setState({ status: "resolved", src: toCollabFileUrl(resolved) });
        } else {
          setState({ status: "error", reference });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error", reference });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, notePath]);

  return state;
}

function ImageRenderer(
  props: { block: { props: { url: string; name: string } } },
) {
  const { notePath } = useContext(ImageResolverContext);
  const { url, name } = props.block.props;
  const [loadError, setLoadError] = useState(false);
  const resolved = useResolvedImageUrl(url, notePath);

  useEffect(() => {
    setLoadError(false);
  }, [url, notePath]);

  if (!url) {
    return (
      <div className="image-block-empty">
        <span className="image-block-empty-text">
          No image source
        </span>
      </div>
    );
  }

  if (resolved.status === "loading") {
    return (
      <div className="image-block-loading">
        <span className="image-block-loading-text">
          Loading image...
        </span>
      </div>
    );
  }

  if (resolved.status === "error" || loadError) {
    const displayName =
      (resolved.status === "error" ? resolved.reference : null) ||
      name || url;
    return (
      <div className="image-block-not-found">
        <span className="image-block-not-found-icon">
          &#x1F5BC;
        </span>
        <span className="image-block-not-found-text">
          Image not found: {displayName}
        </span>
      </div>
    );
  }

  return (
    <img
      className="image-block-img"
      src={resolved.src}
      alt={name || ""}
      draggable={false}
      onError={() => setLoadError(true)}
    />
  );
}

const imageConfig = createImageBlockConfig();

export const CustomImageBlock = createReactBlockSpec(
  imageConfig,
  {
    meta: {
      fileBlockAccept: ["image/*"],
    },
    render: (props) => (
      <ImageRenderer block={props.block} />
    ),
    parse: imageParse(),
    toExternalHTML: (props) => {
      const { url, name } = props.block.props;
      if (!url) return <p />;
      return <img src={url} alt={name || ""} />;
    },
    runsBefore: ["file"],
  },
);
