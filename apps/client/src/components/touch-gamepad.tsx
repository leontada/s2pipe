import { useEffect, useRef } from "preact/hooks";
import { clampAxis, neutralPad, PAD_CENTER, PadButton, type PadState } from "@s2pipe/shared/types/pad";
import { setTouchState } from "../utils/input.ts";

type Props = {
	visible?: boolean;
	opacity?: number;
};

const STICK_MAX_RADIUS = 42;
const STICK_DEADZONE = 0.12;

function haptic(ms = 8): void {
	try {
		if (typeof navigator !== "undefined" && "vibrate" in navigator) {
			navigator.vibrate(ms);
		}
	} catch {}
}

export default function TouchGamepad({ visible = true, opacity = 0.7 }: Props) {
	const activeButtons = useRef<number>(0);
	const lStickState = useRef<{ x: number; y: number }>({ x: PAD_CENTER, y: PAD_CENTER });
	const rStickState = useRef<{ x: number; y: number }>({ x: PAD_CENTER, y: PAD_CENTER });

	const lTouchId = useRef<number | null>(null);
	const lCenter = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const lKnobRef = useRef<HTMLDivElement>(null);
	const lBaseRef = useRef<HTMLDivElement>(null);

	const rTouchId = useRef<number | null>(null);
	const rCenter = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const rKnobRef = useRef<HTMLDivElement>(null);
	const rBaseRef = useRef<HTMLDivElement>(null);

	function commit() {
		const state: PadState = {
			buttons: activeButtons.current,
			lx: lStickState.current.x,
			ly: lStickState.current.y,
			rx: rStickState.current.x,
			ry: rStickState.current.y,
		};
		setTouchState(state);
	}

	function pressButton(btn: number, e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if ((activeButtons.current & btn) === 0) {
			activeButtons.current |= btn;
			haptic(10);
			commit();
		}
	}

	function releaseButton(btn: number, e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if ((activeButtons.current & btn) !== 0) {
			activeButtons.current &= ~btn;
			commit();
		}
	}

	// Handlers para o Analógico Esquerdo (L-Stick)
	function onLStickStart(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (lTouchId.current !== null) return;
		const touch = e.changedTouches[0];
		if (!touch || !lBaseRef.current) return;

		lTouchId.current = touch.identifier;
		const rect = lBaseRef.current.getBoundingClientRect();
		lCenter.current = {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
		haptic(6);
		updateLStick(touch.clientX, touch.clientY);
	}

	function onLStickMove(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (lTouchId.current === null) return;
		for (let i = 0; i < e.changedTouches.length; i++) {
			const touch = e.changedTouches[i];
			if (touch.identifier === lTouchId.current) {
				updateLStick(touch.clientX, touch.clientY);
				break;
			}
		}
	}

	function onLStickEnd(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (lTouchId.current === null) return;
		for (let i = 0; i < e.changedTouches.length; i++) {
			if (e.changedTouches[i].identifier === lTouchId.current) {
				lTouchId.current = null;
				lStickState.current = { x: PAD_CENTER, y: PAD_CENTER };
				if (lKnobRef.current) {
					lKnobRef.current.style.transform = "translate(0px, 0px)";
				}
				commit();
				break;
			}
		}
	}

	function updateLStick(clientX: number, clientY: number) {
		const dx = clientX - lCenter.current.x;
		const dy = clientY - lCenter.current.y;
		const distance = Math.hypot(dx, dy);
		const clampedDistance = Math.min(STICK_MAX_RADIUS, distance);
		const angle = Math.atan2(dy, dx);

		const clampedX = Math.cos(angle) * clampedDistance;
		const clampedY = Math.sin(angle) * clampedDistance;

		if (lKnobRef.current) {
			lKnobRef.current.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
		}

		const norm = clampedDistance / STICK_MAX_RADIUS;
		if (norm < STICK_DEADZONE) {
			lStickState.current = { x: PAD_CENTER, y: PAD_CENTER };
		} else {
			const nx = Math.cos(angle) * norm;
			const ny = Math.sin(angle) * norm;
			lStickState.current = {
				x: clampAxis((nx + 1) * 127.5),
				y: clampAxis((ny + 1) * 127.5),
			};
		}
		commit();
	}

	// Handlers para o Analógico Direito (R-Stick)
	function onRStickStart(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (rTouchId.current !== null) return;
		const touch = e.changedTouches[0];
		if (!touch || !rBaseRef.current) return;

		rTouchId.current = touch.identifier;
		const rect = rBaseRef.current.getBoundingClientRect();
		rCenter.current = {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
		haptic(6);
		updateRStick(touch.clientX, touch.clientY);
	}

	function onRStickMove(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (rTouchId.current === null) return;
		for (let i = 0; i < e.changedTouches.length; i++) {
			const touch = e.changedTouches[i];
			if (touch.identifier === rTouchId.current) {
				updateRStick(touch.clientX, touch.clientY);
				break;
			}
		}
	}

	function onRStickEnd(e: TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (rTouchId.current === null) return;
		for (let i = 0; i < e.changedTouches.length; i++) {
			if (e.changedTouches[i].identifier === rTouchId.current) {
				rTouchId.current = null;
				rStickState.current = { x: PAD_CENTER, y: PAD_CENTER };
				if (rKnobRef.current) {
					rKnobRef.current.style.transform = "translate(0px, 0px)";
				}
				commit();
				break;
			}
		}
	}

	function updateRStick(clientX: number, clientY: number) {
		const dx = clientX - rCenter.current.x;
		const dy = clientY - rCenter.current.y;
		const distance = Math.hypot(dx, dy);
		const clampedDistance = Math.min(STICK_MAX_RADIUS, distance);
		const angle = Math.atan2(dy, dx);

		const clampedX = Math.cos(angle) * clampedDistance;
		const clampedY = Math.sin(angle) * clampedDistance;

		if (rKnobRef.current) {
			rKnobRef.current.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
		}

		const norm = clampedDistance / STICK_MAX_RADIUS;
		if (norm < STICK_DEADZONE) {
			rStickState.current = { x: PAD_CENTER, y: PAD_CENTER };
		} else {
			const nx = Math.cos(angle) * norm;
			const ny = Math.sin(angle) * norm;
			rStickState.current = {
				x: clampAxis((nx + 1) * 127.5),
				y: clampAxis((ny + 1) * 127.5),
			};
		}
		commit();
	}

	useEffect(() => {
		return () => {
			activeButtons.current = 0;
			setTouchState(neutralPad());
		};
	}, []);

	if (!visible) return null;

	const btnEvents = (btn: number) => ({
		onTouchStart: (e: TouchEvent) => pressButton(btn, e),
		onTouchEnd: (e: TouchEvent) => releaseButton(btn, e),
		onTouchCancel: (e: TouchEvent) => releaseButton(btn, e),
	});

	return (
		<div class="touch-gamepad" style={{ "--touch-opacity": String(opacity) }}>
			{/* Gatilhos Superiores */}
			<div class="touch-shoulder-row">
				<div class="touch-triggers-left">
					<button type="button" class="touch-btn touch-btn-zl" {...btnEvents(PadButton.ZL)}>
						ZL
					</button>
					<button type="button" class="touch-btn touch-btn-l" {...btnEvents(PadButton.L)}>
						L
					</button>
				</div>
				<div class="touch-system-center">
					<button type="button" class="touch-btn touch-btn-sys" {...btnEvents(PadButton.Minus)} title="Minus (-)">
						−
					</button>
					<button type="button" class="touch-btn touch-btn-capture" {...btnEvents(PadButton.Capture)} title="Capture">
						⊚
					</button>
					<button type="button" class="touch-btn touch-btn-home" {...btnEvents(PadButton.Home)} title="Home">
						🏠
					</button>
					<button type="button" class="touch-btn touch-btn-sys" {...btnEvents(PadButton.Plus)} title="Plus (+)">
						+
					</button>
				</div>
				<div class="touch-triggers-right">
					<button type="button" class="touch-btn touch-btn-r" {...btnEvents(PadButton.R)}>
						R
					</button>
					<button type="button" class="touch-btn touch-btn-zr" {...btnEvents(PadButton.ZR)}>
						ZR
					</button>
				</div>
			</div>

			{/* Controles Principais (Lado Esquerdo e Direito) */}
			<div class="touch-main-row">
				{/* Lado Esquerdo: Analógico + D-Pad */}
				<div class="touch-side touch-side-left">
					<div
						class="touch-stick-base"
						ref={lBaseRef}
						onTouchStart={onLStickStart}
						onTouchMove={onLStickMove}
						onTouchEnd={onLStickEnd}
						onTouchCancel={onLStickEnd}
					>
						<div class="touch-stick-knob" ref={lKnobRef}>
							<button type="button" class="touch-stick-click" {...btnEvents(PadButton.LStick)}>
								L3
							</button>
						</div>
					</div>

					<div class="touch-dpad">
						<button type="button" class="touch-btn touch-dpad-up" {...btnEvents(PadButton.Up)}>
							▲
						</button>
						<div class="touch-dpad-middle">
							<button type="button" class="touch-btn touch-dpad-left" {...btnEvents(PadButton.Left)}>
								◀
							</button>
							<div class="touch-dpad-center" />
							<button type="button" class="touch-btn touch-dpad-right" {...btnEvents(PadButton.Right)}>
								▶
							</button>
						</div>
						<button type="button" class="touch-btn touch-dpad-down" {...btnEvents(PadButton.Down)}>
							▼
						</button>
					</div>
				</div>

				{/* Lado Direito: Botões ABXY + Câmera (R-Stick) */}
				<div class="touch-side touch-side-right">
					<div class="touch-abxy-cluster">
						<button type="button" class="touch-btn touch-btn-x" {...btnEvents(PadButton.X)}>
							X
						</button>
						<div class="touch-abxy-middle">
							<button type="button" class="touch-btn touch-btn-y" {...btnEvents(PadButton.Y)}>
								Y
							</button>
							<div class="touch-abxy-spacer" />
							<button type="button" class="touch-btn touch-btn-a" {...btnEvents(PadButton.A)}>
								A
							</button>
						</div>
						<button type="button" class="touch-btn touch-btn-b" {...btnEvents(PadButton.B)}>
							B
						</button>
					</div>

					<div
						class="touch-stick-base touch-rstick"
						ref={rBaseRef}
						onTouchStart={onRStickStart}
						onTouchMove={onRStickMove}
						onTouchEnd={onRStickEnd}
						onTouchCancel={onRStickEnd}
					>
						<div class="touch-stick-knob" ref={rKnobRef}>
							<button type="button" class="touch-stick-click" {...btnEvents(PadButton.RStick)}>
								R3
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
