import { Lightbulb } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { PROACTIVE_VIEW_HREF } from "../bots/proactive-mode";

/** Entry point for the global Proactive bots settings, which live with the bots. */
export function ProactiveBots() {
  return <Card role="region" aria-labelledby="proactive-bots-title" className="mb-6 p-5 shadow-none sm:p-6">
    <h2 id="proactive-bots-title" className="text-lg font-semibold">Proactive bots</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">Let bots bring things up with you on their own, such as clients, ideas and plans you mentioned that went nowhere. Choose which bots take part, how often they look and how many messages you get.</p>
    <Button asChild variant="outline" className="mt-4"><a href={PROACTIVE_VIEW_HREF}><Lightbulb aria-hidden="true" />Open proactive bot settings</a></Button>
  </Card>;
}
