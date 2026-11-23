import { lazy, Suspense } from 'react';
import type { Critter } from '@/components/ui/fuzzy-critter-footer';
const Character = lazy(()=>import('@/components/ui/fuzzy-critter-footer'));
const JENNY: Critter[]=[{shape:'flower',colors:['#e26a9d','#ffbdd9'],eyes:'short',size:.86}];
const EMPTY: []=[];
export function JennyAvatar({className=''}:{className?:string}) {
 return <span className={`jenny-character jenny-full-character ${className}`} role="img" aria-label="Jenny, the complete pink fuzzy flower character"><Suspense fallback={<span className="jenny-loading-flower">✿</span>}><Character portrait critters={JENNY} name="" wordmark="" tagline="" columns={EMPTY} legal={EMPTY} copyright="" dropLabel="" curve={false} idleHops={false} sound={false} wind={.5} density={.25} className="jenny-3d"/></Suspense></span>;
}
