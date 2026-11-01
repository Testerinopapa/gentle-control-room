import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postDesktopHostMessage } from "@/lib/api";
import { useDesktopPreferredWindowSize } from "./use-desktop-preferred-window-size";

vi.mock("@/lib/api", () => ({ postDesktopHostMessage: vi.fn() }));
function Card({ signedIn }: { signedIn: boolean }) {
  const ref = useDesktopPreferredWindowSize(signedIn);
  return signedIn ? <div key="alerts" ref={ref} /> : <div key="login" ref={ref} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("desktop content sizing", () => {
  it("measures login and reattaches after authentication without sending content", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 672, height: 580 } as DOMRect);
    const { rerender } = render(<Card signedIn={false} />);
    expect(postDesktopHostMessage).toHaveBeenLastCalledWith({
      type: "desktop.window.setPreferredSize", payload: { contentWidth: 672, contentHeight: 580 },
    });
    rerender(<Card signedIn />);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls[0][0]).not.toBe(observe.mock.calls[1][0]);
  });
});
